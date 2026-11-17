# APEX Local Alpha — consolidated architecture

This document is the single consolidated description of the cognitive runtime and the executive
system as they exist in `apex_app/` after Batch AO-10 and the bounded AP-01 through AP-05
pathways. It
replaces no code and grants nothing. It was written against commit `a2c9a64` (`ao-10`) plus the Batch
AP working tree, by reading the modules and tests named below. Where a statement is a contract enforced by code, the module is
named; where it is a guarantee established by tests, the suite is named; where it is only a
description, it says so.

Three evidence rules apply throughout:

- A passing test is evidence about this code on this platform with a deterministic fixture. It is
  not evidence about a real model, real-world truth, or secure operation in an adversarial
  environment.
- No test in this repository runs a model. Every backend is `NoBackend` or a programmatic stub with
  a fixed reply. The only real-model observations are the dated historical notes in
  [`README.md`](README.md#historical-record-the-controlled-real-model-run-of-2026-10-31).
- Model output, retrieved records, diagnostics, and handoffs are data. None of them authorizes an
  action.

## 1. Status vocabulary used below

| Status | Meaning |
| --- | --- |
| `IMPLEMENTED_AND_TESTED` | Code enforces the behavior, and at least one named test exercises it through a real module or child process. |
| `IMPLEMENTED_PARTIALLY_TESTED` | Code enforces it, but a named boundary has no direct test (for example, no killed child at that instant). |
| `IMPLEMENTED_NOT_DIRECTLY_TESTED` | Code exists and is reachable, but the test evidence is indirect or structural. |
| `DESCRIPTIVE_ONLY` | A written contract or observation exists; nothing enforces it. |
| `NOT_IMPLEMENTED` | No implementation exists. |
| `DEFERRED` | A decision was recorded not to build it in this batch, with the reason. |

## 2. System map

```mermaid
flowchart LR
  U[User request] --> CR[Cognitive runtime<br/>src/cognition/*<br/>read-only, derives claims]
  CR --> ANS[Grounded response<br/>model prose, unverified]
  CR --> PROP[Typed proposal<br/>mp:N, authority none]
  ANS -. not an action .-> U
  PROP --> REG{Action registry<br/>src/actions/registry.js<br/>sole authorization owner}
  U --> REG
  REG -- deny --> DENY[action_denied<br/>nothing runs]
  REG -- allow --> EXEC[Executor<br/>src/actions/executor.js]
  EXEC --> VER[Independent verifier<br/>src/verify/verifier.js]
  VER --> FIN[Finalization + audit<br/>src/controller/finalization.js]
  U --> APPR[User approval<br/>plan content hash + version]
  APPR --> VAL[Plan validity + activation<br/>src/plans/validity.js]
  VAL --> TASK[Task record]
  TASK --> RUN[TaskRunner<br/>src/controller/task-runner.js]
  RUN --> REG
  STORES[(Append-only stores<br/>memory, knowledge, experiences,<br/>predictions, goals, plans, tasks,<br/>world-model, operations, proposals)] -. evidence .-> CR
  STORES -. evidence .-> VAL
  STORES -. audit re-read .-> VER
  FIN --> STORES
  DIAG[Runtime diagnostics<br/>authorizes:false] -. observation only .-> FIN
```

The right-hand side is the only path that can execute anything. The cognitive runtime and the model
sit on the left and can only describe, propose, or refuse. A proposal becomes execution only after
the registry allows it; a plan becomes execution only after a user approval is bound to its bytes and
the plan is activated into an ordinary task; every task step is authorized again when it runs.

## 3. A. Cognitive runtime

All modules in `src/cognition/` are deterministic and read-only unless stated. None writes a store,
calls a model, or grants authority. The model call itself is the gateway (`src/model/gateway.js`),
which the controller invokes; the cognitive runtime validates the reply afterward. The modules beside
the gateway in `src/model/` declare, bound, and validate that transport contract; none of them
contacts an endpoint on its own or opens a second inference path.

| Component | Module | Responsibility | Input → output | Persistence | Authority | Failure behavior | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Request understanding | `cognition/request.js` | Classify intent, referents, time range, ambiguity, unsupported capability, missing information | Request text + store-derived context → structured understanding | None | None; description only | Ambiguity becomes a clarification before any model call; unsupported capability is named | `cognition-understanding.test.js`, `cognition-scenarios.test.js` D |
| Evidence retrieval | `cognition/evidence.js` | Bounded reads across memory, knowledge, experience, adaptation, temporal summary, prediction, World Model, goals/plans/tasks, conversation, request | Stores → one evidence shape per record, with source, validity, status, relationships; omissions counted | None | None | A source that was read and empty, unavailable, or damaged is kept distinct; absence is not negative proof | `cognition-reasoning.test.js`, `cognition-evidence-states.test.js` |
| Claim extraction and contradiction map | `cognition/claims.js` | Extract claims, classify kinds, reduce duplicates, keep both sides of a disagreement | Evidence → claims + contradiction map | None | None | Both sides retained; no recency/source-rank resolution | `cognition-lineage.test.js`, `cognition-evidence-states.test.js`, `cognition-scenarios.test.js` B |
| Deliberation | `cognition/deliberation.js` | Thirteen ordered deterministic steps from question to decision and disclosures | Claims + contradictions + uncertainty → deliberation result | None | None | A decision is `answer`, `clarify`, `abstain`, `refuse`, or `recommend`; no step executes | `cognition-reasoning.test.js`, `cognition-scenarios.test.js` |
| Grounded response construction | `cognition/response.js` | Build the bounded grounding brief, validate structured responses and plain answers, phrase disclosures, correct model action claims | Analysis → brief + validation result + disclosure text | None | None | A citation the model did not retrieve, a forged state, or an over-certain structure is rejected whole | `cognition-reasoning.test.js`, `cognition-evidence-states.test.js` |
| Deterministic offline answer | `cognition/response.js` (`buildDeterministicAnswer`) + `controller/controller.js` (`#offlineAnswer`) | With no backend configured, answer from the model-free analysis the request already ran: render only claims resting on prompt-eligible memory/knowledge evidence ids, cited and bounded; otherwise show the records directly and report `model_unavailable` | Analysis + eligible evidence ids → `success_deterministic` display with a content-free audit summary, or the no-model result | None; the operation record only | None; `authorizes:false`; never completes a goal, captures an experience, or executes | Record content stays out of the audited output and conversation turns; private and below-relevance records are never rendered; a contradiction shows both sides as disputed; an ambiguous reference is clarified before any prompt exists; an unsupported question stays `model_unavailable` | `offline-answer.test.js` (13 cases, real controller/stores/CLI child processes) |
| Model protocol | `cognition/protocol.js` | Extract, bound, parse, and reject the optional `COGNITION` line | Model text → parsed structure or refusal | None | None | Malformed, oversized, non-object, duplicate, or unknown-kind structures are rejected whole | `cognition-contract.test.js`, `proposal-boundary-an.test.js` |
| Model gateway | `model/gateway.js` | Replaceable backend; classifies every reply and records provenance | Request → `valid`/`empty`/`refused`/`unavailable`/`malformed`/`context_limit`/`cancelled` reply | None | None | Cancellation is distinct from timeout; only `UNREACHABLE`/`INTERRUPTED` retry; refusal/empty/malformed never retried into a different outcome | `gateway.test.js`, `gateway-resilience.test.js`, `runtime-states.test.js` |
| Provider contract (T-04) | `model/contract.js` + `model.contracts` | Declare what the configured backend and APEX's own transport support — capability vocabulary, limits, protocol states, trust boundary — without contacting the endpoint; `model.contracts` renders and verifies the declaration | Gateway → frozen declaration with `probed:false` and `verified:false` | None | None; no endpoint is contacted and no capability is inferred from a successful call | An unknown backend declares everything unsupported with a reason; an inconsistent or tampered declaration is refused whole | `model-architecture.test.js` |
| Context budget (T-04) | `model/gateway.js` (`estimateTokens`, `contextBudget`) | Refuse locally before sending when the prompt exceeds a declared window; the figure is an estimate (characters ÷ 4), not a tokenizer measurement | Prompt + declared window → estimate and fit/refuse decision | None | None | No declared window → no enforcement; abort is checked before the budget; a refusal names the estimate and says the request was not sent | `model-architecture.test.js` |
| Structured output (T-04) | `model/structured.js` | Validate a model reply as a single bounded JSON object against a small schema subset; refuse authority and prototype keys at any depth; wrap a suggestion as non-authoritative | Model text + schema → object or whole rejection; suggestion envelope | None | Envelope states `authority:'none'`, `executable:false`, `verified:false`, `recorded:false` | Prose, a code fence, an array, oversized text, an unknown key, or a forbidden authority key → rejected whole | `model-architecture.test.js` |
| Streaming contract (T-04) | `model/streaming.js` | Typed chunks (`text`/`usage`/`done`/`error`), a bounded collector, control characters stripped before joining, partial text discarded on any failure | Chunk iterator → joined text and usage, or a classified failure | None | None | Incomplete, empty, or oversized → failure with no partial text; no configured backend streams, so `chunksFromResult` marks every chunk `simulated:true` | `model-architecture.test.js` |
| Neural proposal boundary (T-05) | `neural/contract.js`, `neural/runtime.js`, `neural/lifecycle.js`, `neural/diagnostics.js`, `neural.contract` | Build a bounded `apex.neural.request/1`, parse and validate `apex.neural.response/1`, classify every refusal by name, enforce one in-flight request, apply a deadline and abort signal, attach provenance, and check a declaration for consistency; `neural.contract` renders and verifies the declaration | A connected transport (none ships) → classified result with frozen proposals, or a named failure; nothing reaches a store or an action | None (the lifecycle keeps bounded counters in memory) | None; results state `authorizes:false`, `executed:false`, `recorded:false`, `verified:false` | No configured runtime → `NOT_CONFIGURED` before any transport; a second concurrent request is refused and counted; a late reply after cancel is discarded; proposals feed `checkSteps()` and are refused as model-origin writes | `neural-boundary.test.js` (28 cases); `src/neural/simulated.js` is a deterministic test transport, not a runtime |
| Model-output validation | `cognition/engine.js` + `response.js` | Validate the model's structure against this request's analysis and evidence ids | Model structure + analysis → accepted or rejected result | None | None | Never approves, writes, executes, or marks evidence verified | `cognition-contract.test.js`, `cognition-evidence-states.test.js` |
| Typed artifacts | `cognition/artifacts.js` | One shape per value crossing a stage boundary; validate at the boundary | Stage value → validated artifact or whole rejection | None | Each artifact states `authorizes: false` or an equivalent non-authority | Malformed or self-contradictory artifact is rejected whole; nothing is copied | `cognition-artifacts.test.js` |
| Lifecycle contract | `cognition/lifecycle.js` + `contract.js` | Ten stages as an executable state machine; allowed entry per stage; failed/skipped/unavailable stages close dependants | Stage events → lifecycle snapshot + audit | None (the audit is carried on the operation record) | None; `action_registry` named as owner | A stage cannot start from a failed prerequisite; a skipped authorization or execution cannot carry a dependent stage | `cognition-lifecycle.test.js`, `cognition-contract.test.js` |
| Cancellation and request identity | `lifecycle.js`, `controller/controller.js`, `session.js` | Request id; cancellation signal; distinguish cancelled from timeout; discard late replies | Signal + request id → terminal lifecycle state | Operation record only | None | A cancelled request records no answer and no execution; a late reply is discarded | `cognition-lifecycle.test.js` (real `cancelled-request-child.mjs`) |
| Cognitive trace | `cognition/trace.js` | Bounded audit trace: stages, counts, evidence ids, refusals, validation, execution boundary | Lifecycle + step records → trace | Attached to the operation record | None; every trace says `authorizes:false` | Free text is filtered against fixed labels; prose and reasoning cannot enter | `cognition-trace.test.js` |
| Evidence lineage | `cognition/lineage.js` | Record what a claim rested on; later re-assess against current records without rewriting history | Claim + recorded refs → snapshot + separate reassessment | Snapshot is carried in the operation/cognition audit | None | Missing/unreadable evidence → unverified, never false; retracted/superseded → weakened | `cognition-lineage.test.js` |
| Late evidence re-check | `cognition/evidence.js` (`recheckEvidence`) + `controller.js` (`#recheckAnswerEvidence`) | Re-read only cited memory/knowledge ids after the model answers; report changes | Recorded claims + stores → `evidenceRecheck` record + display notice | Read-only; attached to the operation | `authorizes: false`; never rewrites lineage | Unreadable record → weakened to unverified; unavailable source named; bounded to 128 ids | `acceptance-ao09.test.js` 4-5 |
| Deterministic evaluation | `cognition/evaluation.js` | Fixed synthetic scenarios over the deterministic pipeline; per-dimension findings; no composite score | Scenarios → findings + pass/fail per dimension | None; pure and non-mutating | None | A finding names the defect class; a pass means the implementation matched the written rubric | `cognition-evaluation.test.js`, `acceptance-ao09.test.js` 6 |
| Runtime diagnostics | `cognition/runtime-diagnostics.js` | Bounded per-request stage record: outcomes, durations, counts, cancellation, failure, retries | `SpanRecorder` + lifecycle → diagnostics record | Attached to the operation line already being appended | `authorizes: false`; nothing reads it to decide | Clock fault → duration `null`; build failure → `available:false`; outcome/status untouched | `runtime-diagnostics-ao.test.js` |

What this layer does **not** do: it does not simulate understanding, does not produce a confidence
score, does not resolve a contradiction, does not turn a model answer into a verified fact, and does
not authorize. Its outputs are the input to the model prompt, or the validation of the model's
output, or a record attached to an operation that has already been decided elsewhere.

## 4. B. Executive system

| Component | Module | Responsibility | Authority owner | Persistence | Failure behavior | Tests |
| --- | --- | --- | --- | --- | --- | --- |
| Goals | `goals/model.js`, `goals/store.js`, `goals/assess.js`, `actions/goal-actions.js` | Goal records, criteria, legal transitions, evidence rules, append-only reducer; completion requires a live `success_verified` audit operation | User (`goal add/update/evidence/complete/link`) | `goals.jsonl` under the goal write lock | No evidence → not complete; conflicting evidence → not satisfied; a model cannot write | `goal-system.test.js`, `goal-provenance.test.js`, `goal-assessment.test.js`, `goal-evidence-consistency.test.js` |
| Candidate planning | `plans/candidates.js`, `plans/evaluation.js`, `executive/selection.js` | Candidate approaches the recorded goal supports; gate-then-Pareto comparison; each step names a registered action | User records and approves; nothing starts | Draft plans in `plans.jsonl` only after the user acts | An unavailable capability excludes the candidate; unmappable parts stay recorded unknowns | `plan-candidates.test.js`, `plan-generation.test.js`, `plan-evaluation.test.js`, `plan-dimensions.test.js` |
| Objective outlining (T-03) | `plans/objective.js`, `actions/plan-actions.js` (`plan.outline`), `executive/mapping.js` | Read a free-form objective against the live registry: parts in written order, the typed step each mapped part becomes, parts no capability can take, duplicates, planner refusals, risks, uncertainty, revalidation and recovery; alternatives are re-synthesized from the same texts with only an exclusion or dedup applied | None; the read records, approves and starts nothing (`authorizes:false`, `recorded:false`, `approved:false`) | None (read) | An invalid or secret-like objective is refused at validation; a draft is withheld when `cannot_use` names one of its steps; the verifier re-derives the whole outline and refuses on any byte difference, an unregistered action, or a now-refused step | `objective-planner.test.js` |
| Plan validation | `plans/validity.js`, `plans/model.js` | Validate live registry, dependencies, goal revision, evidence, constraints, approval binding | Controller on activation; registry on each step | `plans.jsonl` | A stale approval, missing action, failed dependency, or unreadable constraint refuses activation | `plan-constraints.test.js`, `plan-continuation.test.js`, `plan-adversarial.test.js` |
| User approval and hash binding | `plans/model.js`, `executive/preview.js`, `actions/plan-actions.js` | Approval is a user-origin event bound to plan version + content hash; preview prints what is approved | User only | `plans.jsonl` (`plan.approval`) | A revision clears approval; an approval from another version/hash cannot activate new bytes | `handoff-hash-binding-ao.test.js`, `executive-acceptance.test.js` K-04, K-22 |
| Authorization | `actions/registry.js` | Every action declares permission (`read`/`write`) and origins; write actions are user-only; a model-origin write cannot be registered | Action registry | None (policy in code) | Unknown action/origin denied; denied step executes nothing | `model-self-authorization.test.js`, `proposal-boundary-an.test.js`, `capability-inventory.test.js` |
| Executive handoff | `executive/handoff.js`, `executive/mapping.js` | Record each crossing as one bounded handoff: model proposal, plan activation, or task run; ids, hashes, recorded outcomes | None; every handoff says `authorizes:false` | Attached to the operation record | Invalid construct or stale reference fails closed; no request/input/model text | `handoff-integrity-ao.test.js`, `handoff-hash-binding-ao.test.js`, `executive-bridge.test.js` |
| TaskRunner | `controller/task-runner.js`, `tasks/model.js`, `tasks/store.js` | Run each step through the controller's existing action path; own task/step transitions; record one `task.step` operation per executed step | Task creation (user) or task approval (user, for model-proposed tasks); registry per step | `tasks.jsonl` under the task lock | A failed step stops dependants; an interrupted step is uncertain, never success; no replay | `tasks.test.js`, `task-lifecycle.test.js`, `executive-acceptance.test.js` K-13–K-18 |
| Execution | `actions/executor.js`, `actions/builtin.js`, `actions/*-actions.js` | Validate input and run the action body; report what happened only | Registry already allowed it | The action's own store | Validation error → `input_rejected`; body throws → execution failed; no verification claimed | `actions.test.js`, `failure-semantics.test.js` |
| Independent verification | `verify/verifier.js` | A different component re-reads the store or recomputes the value and decides the postcondition | None; it reports only | None | Verifier unavailable/failed → not success; independent of executor | `executive-acceptance.test.js`, `executive-bridge.test.js`, `integration-runtime-an.test.js` |
| Finalization and audit | `controller/finalization.js`, `operations/operation-log.js` | One completion contract for every path: audit append, experience capture, completion; masking and minimization at the write boundary | Operation log's single append path | `operations.jsonl` | Audit append failure downgrades success and reports `recorded:false`; never invents experience | `finalization-contract.test.js`, `finalization-interruption.test.js`, `append-audit-failure-semantics.test.js` |
| Continuation and recovery | `plans/continuation.js`, `continuation/engine.js`, `executive/recovery.js`, `tasks/lock-recovery.js` | Read nine states from plan/task/audit records; take up only steps proven never to have started; refuse to replay an uncertain effect | User initiates continuation; no background recovery | Reads only; the resulting step runs through the normal path | A refused or unsafe continuation executes and writes nothing; a second continuation takes up nothing | `plan-continuation.test.js` (real children), `continuation-cross-process-an.test.js`, `executive-readiness.test.js`, `expectation-caution.test.js` |
| Prediction and experience | `prediction/*`, `experience/*`, `actions/prediction-actions.js`, `actions/experience-actions.js` | Append-only expectation and experience records; feedback; adaptation candidates; outcome evaluation derived at read time | User writes only; a model cannot write | `predictions.jsonl`, `experiences.jsonl` under their locks | An expired horizon is not a wrong prediction; a rate below 20 evaluations is withheld; a damaged store is unavailable, not empty | `prediction-*.test.js`, `experience-*.test.js` |
| Adaptation boundary | `experience/derivation.js`, `experience/experience-store.js`, `plans/guidance.js` | Repeated user corrections may yield one candidate rule; only a user decision approves it; an approved rule may shape (never gate) a later selection | User approval only | `experiences.jsonl` | A retired rule shapes nothing; two conflicting approved rules are disclosed, neither chosen | `experience-adaptation.test.js`, `plan-guidance.test.js`, `adversarial-batch-am.test.js` I-01–I-08 |
| Decision adaptation (AP-01) | `plans/evaluation.js` (`adaptationDecisionOf`), `plans/guidance.js`, `executive/selection.js` | One approved, shaped adaptation may change only which candidate leads a comparison; the decision block states the order the same rule would have produced without it, with rule ids, versions, hashes and bounded evidence ids | User approval only; the block says `authorizes:false` | None; carried on the audited `plan.candidates`/`plan.replan` read and its display | No applicable record → declined with the ledger's own reason; candidate bytes that changed since the comparison are refused by selection | `adaptation-decision.test.js`, `plan-guidance.test.js`, `plan-learning.test.js` |
| Prediction-derived adaptation (AP-02) | `experience/prediction-derivation.js`, `experience/experience-store.js`, `actions/experience-actions.js` (`adaptation.derive`, `adaptation.eligibility`) | One completed, valid evaluation of one user-recorded prediction may become a bounded, typed adaptation **candidate**; the user inspects it and approves it through the existing `adaptation.decide`; only then does it feed the same AP-01 dimension | User approval only; derivation only creates a candidate; the candidate cannot serialize any executable text | One adaptation record and its lifecycle events in `experiences.jsonl`, unchanged in shape; `predictionEvidence` on the record is a pointer, and currentness is re-read from `predictions.jsonl` | Awaiting / expired / invalidated / superseded / conflicting / stale / model-origin / duplicated evidence is inert with a state; stale or unreadable lineage forces `active:false` on read; no parallel learning store | `prediction-adaptation-learning.test.js` (21 cases), `adaptation-decision.test.js`, `prediction-adaptation-boundary.test.js` |

### Who owns each transition

| Transition | Owner | Record that establishes it |
| --- | --- | --- |
| Interpret a request | Cognitive runtime | Analysis on the operation record (`authorizes:false`) |
| Retrieve evidence | Cognitive runtime | Evidence ids and counts on the analysis |
| Ask the model | Controller, through the gateway | Gateway reply classification + provenance (`verified:false`) |
| Validate model output | Controller | Validation result; rejection is disclosed |
| Propose an action | Model (untrusted) | Typed proposal `mp:N`, `authority:'none'` |
| Approve a plan | User | `plan.approval = { at, version, contentHash, validation }` |
| Validate and activate a plan | Controller | `plan.activation` + `plan.activate` handoff |
| Authorize an action | Action registry | Step `authorization` field |
| Execute an action | Executor | Step `execution` field |
| Verify a result | Independent verifier | Step `verification.outcome` |
| Record the operation | Finalization contract | Whether the audit line was appended |
| Continue an interrupted run | User, explicitly | Continuation reading + new step records |

### The one decision an approved record may move (AP-01)

The pathway is: **a recorded outcome → an approved adaptation with a recorded shape → one later
comparison's ordering → the decision states what it would have been without the record → retirement
restores the unadapted ordering.** It uses the existing experience store, the existing one-user
approval (`adaptation.decide`), the existing shape record (`adaptation.guide`), the existing
retirement event (`adaptation.retire`), and the existing gate-then-Pareto comparison. No store,
planner, registry, authorization rule, or execution path was added.

- **Decision point.** Only the *leading candidate* of a `plan.candidates` or `plan.replan`
  comparison can move, and only through the one ranked dimension `approved_adaptation_fit`. The
  eligible signal is the user's recorded feedback/experience that supports an adaptation the user
  approved. A model suggestion or an unapproved candidate rule is never an eligible signal: the
  eligibility and adversarial suites prove each has no effect. A prediction verdict reaches this
  point only after a user-approved prediction-derived candidate exists (AP-02, below); the verdict
  alone does nothing.
- **Eligibility rules.** A record can move the ordering only when all of these hold in the ledger
  read for this comparison: the user approved it; it is active; its supporting evidence still
  stands; it has a recorded shape; its scope names a capability these candidates use; it does not
  contradict another active record in its scope; and the fields it states are answerable by the
  candidates' own steps. Anything else is reported with the state that made it inert
  (`candidate`, `rejected`, `retired`, `ambiguous`, `stale`, `unshaped`, `out_of_scope`,
  `conflicted`, `contradicted`) and moves nothing. Unknown fields, a malformed shape, or a step
  bound outside 1–8 are refused by the store before any comparison sees them.
- **What the decision discloses.** The `adaptationDecision` block carries the schema
  `apex.adaptation-decision.v1`, the dimension it can move, the front and leading candidate
  *without* the dimension and *with* it, whether the record applied and whether the outcome changed,
  the applied rules (id, capability, version, rule hash, bounded support ids), the deduplicated and
  bounded evidence ids, every record considered with its state and reason, the ledger's own
  decline reason when nothing applied, the guidance digest, and `authorizes:false`. It carries no
  free-form reasoning and no score.
- **Authority boundary.** The block is computed after the gates, the included set, the candidate
  bytes, the ranked dimensions and the front are already fixed; it cannot re-admit a gated
  candidate, change a step, change an approval, change authorization, change verification, or start
  anything. `selectCandidate` additionally refuses a leader whose digest no longer matches the
  candidate list, so an influenced comparison cannot record bytes it did not read. The plan that
  results is still an ordinary draft that needs the user's approval and the normal validation.
- **Reversal.** `adaptation.retire` is the reversal. The records are append-only: the approval, the
  shape, the support and the retiring event all remain. The next comparison reads the retired state,
  reports it as inert with its reason, applies nothing, and produces the same ordering the
  unadapted rule produced before approval. Reversal never rewrites the earlier decision, never
  changes an approved or executed plan, and never changes a historical audit line.
- **Tests and cost.** `tests/adaptation-decision.test.js` covers eligibility, malformed/unknown
  rules, duplicate evidence, the before/after/after-reversal fixture, selection refusal on changed
  bytes, model-origin refusals, expired/awaiting predictions, authorization and registry
  invariance, and audit-write failure. The decision path was measured before (the module extracted
  from the pre-AP commit) and after, in one process, at 4 / 10 / 20 candidates: the added block
  costs about 0.04 / 0.01 / 0.41 ms, or 25% / 3% / 48% of a comparison that itself takes
  0.14 / 0.26 / 0.85 ms. No cache or index is justified by these figures.
- **What it does not claim.** An applied record orders approaches; it does not predict that the
  ordered approach will succeed, does not establish a causal effect of past outcomes, and does not
  fit a weight or recompute a ranking from results. Prediction verdicts have no effect of their own:
  they reach this pathway only through a user-approved prediction-derived candidate (AP-02, below).

### How a prediction verdict may inform that one decision (AP-02)

Batch AP-02 extends the same pathway to a second kind of recorded evidence — an expectation the user
recorded and a verdict a deterministic evaluation derived from it — **without a parallel learning
system**. It adds one pure derivation module, one read action, and a prediction branch inside the
existing derivation and store; it adds no store, no planner, no registry entry, no authorization
rule, and no second decision dimension. The five transitions are separate and each is a different
fact:

| Transition | What establishes it | What it does **not** do |
| --- | --- | --- |
| **Recorded** | `prediction record`: the user states an expectation, a capability, a horizon, and cited evidence; user origin only | It is not an observation, a verdict, or a rule; no model can write one |
| **Evaluated** | `prediction evaluate`: compares the expectation with outcome experiences inside the horizon and stores a verdict only when they establish one | It does not approve an adaptation, create a candidate, or change any other record |
| **Eligible** | `predictionEligibility` over a projection: completed, valid, current evidence, readable lineage, current outcome records | It does not derive or approve anything; it only answers whether a candidate *could* rest on this evaluation |
| **Approved** | `adaptation.decide` by the user on a derived candidate, appended to `experiences.jsonl` | Approval is not inferred from a successful evaluation, and it grants no permission |
| **Influencing** | The AP-01 read: approved + active + intact support + a recorded shape + current prediction evidence, feeding only `approved_adaptation_fit` | It cannot change candidate bytes, gates, plan steps, goal criteria, approvals, authorization, execution, or verification |

- **Eligibility rules (closed states).** `experience/prediction-derivation.js` judges one projection:
  a missing projection or a status other than `evaluated` is `not_evaluated`; a scope that is not a
  capability name is `not_scopable`; a non-user origin is `provenance_not_user`; a withdrawal is
  `invalidated`; a replacement (or a retired flag) is `superseded`; no stored evaluation is
  `evaluation_missing`; a recorded verdict a fresh read would settle differently is
  `evaluation_stale`; an unreadable experience log is `evidence_unavailable`; a cited record that
  does not resolve is `unresolved_citation`; an evaluation that cites no still-current outcome
  experience, or names no deciding outcome class, is `outcome_evidence_not_current`. Any state other
  than `eligible` is inert and carries its reason. Awaiting and expired predictions never reach
  `evaluated`, so they are inert; expired is not incorrect.
- **What the proposal may say.** The mapping is the explicit, closed `OUTCOME_PROPOSAL_FIELD`:
  a recorded `success` proposes `prefer` for the capability; `failure` and `blocked` propose
  `avoid`. The *verdict word* is not the rule — a contradicted verdict still follows the recorded
  outcome class, and the mapping is printed in the record so a reader can disagree with it. The
  prediction's own subject text is display-only and is never parsed; the proposal is a typed
  object (`type: 'evaluated_prediction'`, `dimension: 'approved_adaptation_fit'`,
  `guidance: { order, avoid, prefer, maxSteps }`, `verdicts`, `limitations`, `evidenceDigest`), and
  an unknown type or malformed field is refused. There is no free-form text that can execute.
- **One evaluation, one candidate.** Derivation stores a candidate with
  `method: 'evaluated_prediction'`, `minSupport: 1`, and exactly one prediction id and one
  evaluation id in `support`. Repeated derivation with the same prediction is skipped, a duplicate
  citation cannot add a second candidate, and the decision's evidence lists are deduplicated and
  bounded. A prediction-derived proposal whose normalized scope-and-rule key equals an existing
  rule does not create a parallel rule for the same scope.
- **Approval is unchanged and explicit.** `adaptation.derive` only appends an unapproved candidate;
  its independent verification re-reads the record and refuses if the candidate is active, if its
  provenance is not deterministic derivation, or if it does not cite exactly one current prediction
  and evaluation. `adaptation.decide` remains the only approval, remains user-origin only, and
  verifies that the decision did not change the candidate's rule or scope. A successful evaluation
  is never treated as consent.
- **Currentness is re-read, not cached.** The store overlays a prediction-derived record on read
  with `source: 'prediction'`, `shapeSource: 'proposal'`, and `predictionEvidence`. For every active
  prediction-derived row it re-reads the `predictions` ledger once (`details`, the batch read added
  in AP-03; no retention between checks, no index) and forces
  `active:false` with an `inactiveReason` of `prediction_store_unavailable` or `evaluation_changed`
  when the ledger no longer supports the record. An approval is preserved; its effect is withdrawn
  until the lineage is explicitly reconciled. A re-evaluation or invalidation therefore cannot leave
  stale guidance active.
- **Disclosure is the AP-01 block.** `adaptationDecision` is unchanged in schema
  (`apex.adaptation-decision.v1`), carries `authorizes:false`, and gains only a per-rule
  `source`/`method` and a `sources.predictionEvidence` distinction: `none` when no prediction record
  was considered, `both` when feedback- and prediction-derived rules both applied,
  `prediction_derived` when only a prediction-derived rule applied, and `prediction_rejected` when
  prediction evidence was considered and could not be used, naming each rejected record and its
  state. Feedback-only is `predictionEvidence: 'none'` with a non-empty `feedbackDerived` list. The
  counterfactual removes `approved_adaptation_fit` exactly as AP-01 did; there is no new dimension.
  A combined outcome never double-counts one prediction: the same record id appears once, and the
  evidence lists are per-kind.
- **Reversal and lineage.** `adaptation.retire` works identically for a prediction-derived record:
  the candidate, decision, proposal and prediction/evaluation ids stay readable, and the next
  comparison returns the unadapted order. Retirement or invalidation of the prediction itself makes
  the record ineligible on the next read rather than rewriting history; an existing decision is never
  retroactively changed, and no already-approved plan or executed task is altered.
- **Tests and cost.** `tests/prediction-adaptation-learning.test.js` (21 cases, registered in
  `npm test`) covers the eligibility matrix, inert waiting/expired/invalidated/superseded evidence,
  stale and unreadable lineages, model-origin refusal, duplicate non-amplification, approval
  separation, typed-rule refusal, the five disclosure distinctions, the real-store/controller/audit
  end-to-end run, retirement, and audit-append failure. The pure decision path was benchmarked
  against AP-01 on identical fixtures (see `benchmarks/README.md`); it shows no measurable added
  overhead there. The AP-02-specific cost is the currentness store read, and AP-03 turned it from
  one ledger read per cited prediction into one ledger read per check (see below).
- **What it does not claim.** It does not claim APEX predicts accurately, that a prediction is a
  probability, that an evaluated outcome caused the later result, or that any of this improves work.
  It claims only that one completed evaluation can become a candidate, that only the user's approval
  makes it evidence, and that the resulting ordering influence is disclosed, bounded, auditable and
  reversible.

### How repeated recorded outcomes may be described and, separately, approved (AP-03)

Batch AP-03 extends AP-02 from one evaluated prediction to a bounded sequence of them. It answers a
narrower question than "what always happens": *in one capability's recorded history, is the order of
recorded outcomes repeated, alternating, turning, or not enough to say?* The answer is a read-time
analysis, not a stored fact. It adds one pure module (`prediction/longitudinal.js`), a derivation
branch that may cite several evaluations, one read action (`longitudinal`), and one batched ledger
read used by the currentness check. It adds no store, no new prediction or experience file, no
planner, no new permission or origin, no authorization rule, and no second decision dimension.

- **Read-only analysis.** `analyzeLongitudinal` takes the predictions whose evaluation is known and
  projects a scoped report. Nothing is written: no record is repaired, promoted, or annotated, and
  the ledger is only read. The report carries schema `apex.longitudinal.v1` and repeats the note
  that it "makes no causal claim, states no confidence, and approves nothing".
- **The pattern vocabulary is closed.** Eight kinds, no free-form parsing:
  `repeated_success`, `repeated_failure`, `alternating_outcomes`, `consistent_improvement`,
  `consistent_regression`, `mixed_outcomes`, `insufficient_evidence`, `conflicting_evidence`. The
  first four state a direction a candidate may carry; the last four describe evidence that supports
  no single direction and therefore propose nothing. `MIN_REPEATED_OBSERVATIONS = 2` and
  `MIN_SEQUENCE_OBSERVATIONS = 3` are definitions of "repeated" and "a sequence", not accuracy
  thresholds: two observations can repeat, and three are needed before an order can alternate or
  turn.
- **Grouping, dedupe and exclusions.** A group is one capability name; a parent name never absorbs a
  child capability's records, and unrelated capabilities are never merged. Observations are ordered
  chronologically by recorded outcome time, deduplicated by prediction id and evaluation id, and each
  observation names its own prediction, evaluation and evidence ids. A citation cannot count twice.
  Records withdrawn, replaced, expired, stale, unreadable, non-user, or outside a capability scope are
  **excluded by kind**, each with its wording; the report prints up to 20 exclusions per group and
  says when it truncated. A missing record is never read as a failure: absence is an exclusion with
  a reason, and an unreadable store is a refusal, not an empty history.
- **Calibration is separate and unchanged.** The existing derivation is reused verbatim, with its
  floor of **20 scored evaluations** intact. The report states recorded, evaluated, eligible-scored
  and excluded counts; below the floor, calibration is explicitly `unavailable` with the reason
  `below 20`, and is never read as a good or poor rate. Calibration is not authorization.
- **Bounded reads are disclosed.** The derivation reads at most 20 predictions
  (`MAX_LONGITUDINAL_PREDICTIONS`). When the scope holds more, the read is partial, the report says
  so, and **no pattern is derived from it**: a rule is refused rather than inferred from a prefix of
  the history. The report also bounds groups (20), observations and exclusions shown per group (20),
  and support refs per rule (20), and says which of those it hit.
- **A pattern may become a candidate; it never approves one.** `adaptation.derive` turns a
  directional pattern into a candidate with `method: 'repeated_outcome_pattern'`, an explicit
  `type: 'repeated_outcome_pattern'` proposal, `minSupport: 1`, and the cited prediction and
  evaluation ids in `support` (bounded at 20). The rule is the recorded pattern's direction mapped
  through a closed mapping, printed in the record so a reader can disagree with it; the predictions'
  subject text is display-only and never parsed. `adaptation.decide` remains the only approval and
  remains user-origin only. A repeated pattern is never automatically promoted to an executable rule.
- **One scope, one answer.** The scope is answered by its pattern, not also by each member: a
  prediction covered by the longitudinal candidate is not additionally turned into its own
  single-evaluation candidate. Normalized scope-and-rule keying still prevents a parallel rule for
  the same scope, and the derivation's independent verification refuses a candidate whose citations
  no longer resolve.
- **Influence is the AP-01 dimension, with a distinguishable basis.** An approved longitudinal
  candidate feeds only `approved_adaptation_fit`. The decision block gains
  `sources.longitudinalDerived` beside `sources.singleEvaluationDerived` and
  `sources.predictionEvidence`, and each applied rule carries `basis` (`repeated_feedback`,
  `single_evaluation`, or `longitudinal_pattern`), so a reader can tell a single observation from a
  supported sequence. The counterfactual, candidate bytes, gates and ranked dimensions are
  unchanged; there is no new dimension and no new authorization pathway.
- **Currentness is one ledger read per check.** Every adaptation read re-judges each cited
  prediction against the live ledger via `predictions.details`, which reads and projects the log
  once for all references (including the predictions cited by longitudinal candidates). Nothing is
  retained between checks, so a re-evaluation, invalidation, or a later outcome inside a cited
  horizon makes the record ineligible until reconciled; the approval stands, its effect is withheld,
  and on reconciliation the unadapted decision returns without any record being rewritten.
  `tests/longitudinal-outcome-analysis.test.js` asserts the batched read returns exactly what one
  read per citation returned.
- **Reversal.** `adaptation.retire` remains the reversal for a longitudinal record exactly as for
  AP-01/AP-02: the retire event is appended, the next comparison reports the record inert with its
  reason and restores the unadapted ordering, and no prediction, evaluation, feedback, adaptation,
  plan or task history is rewritten.
- **Tests and cost.** `tests/longitudinal-outcome-analysis.test.js` (registered in `npm test`)
  covers the vocabulary and eligibility matrix, calibration at 19 vs 20, duplicate evaluations and
  citations, exclusion kinds (expiry is not failure, missing is not failure), mixed/alternating
  groups, unrelated capabilities, conflicting and damaged-store evidence, model-origin
  ineligibility, that aggregation can neither approve nor activate, that only an approved adaptation
  moves the dimension, re-evaluation/invalidation removing influence, retirement restoring the
  baseline, refusal to bypass plan approval/authorization/execution/verification, concurrent changes
  not leaving stale influence, and a deterministic end-to-end run through real stores, controller and
  audit. `benchmarks/run-longitudinal-benchmark.mjs` measures the pure analysis as history grows
  (20 / 100 / 500 / 1000 evaluations) and the **complete** production request path. With one
  capability and 8 / 14 / 19 recorded evaluations the AP-03 rule moves the decision by a median
  `+1.2 / +5.8 / +7.1 ms` over the no-rule request, against AP-02's `+0.5 / +19.1 / +2.3 ms`; the
  figures include the currentness read and machine noise and are observations of one machine, not a
  specification.
- **What it does not claim.** A repeated association in recorded order is not a cause, not a
  probability, not a confidence, and not a forecast. The analysis does not say a capability will
  succeed, does not fit a weight, does not compute an accuracy, and does not approve, activate, or
  execute anything. It claims only that a bounded, scoped, deduplicated sequence of recorded outcomes
  can be described and shown, that a directional one can become a candidate, and that only the user's
  explicit approval lets it move one disclosed comparison.

### How an approved adaptation is traced to its outcomes, without claiming cause (AP-04)

Batch AP-04 answers a different question from AP-01 through AP-03. Those batches let a record move
one disclosed comparison; AP-04 asks whether the *decisions that record was actually part of* were
followed by better, worse, or unchanged recorded outcomes. It adds one pure read module
(`plans/effectiveness.js`), one read action (`adaptation.effectiveness`), a controller method and a
CLI command. It adds no store, no new record type, no planner, no permission or origin, no new
decision dimension, and no execution path. Nothing in the read approves, guides, retires, retries, or
executes anything.

- **Approval is not application, application is not success, and success is not cause.** The read
  keeps these four apart in its own vocabulary. A record with a decision and no disclosed use is
  `approved_never_applied`; a use whose plan has not reached an outcome is `applied_outcome_pending`;
  a verified execution whose assessment failed is `applied_failed`, not a success; and an evaluated
  success is only ever described as an association with the plan that ran under the rule, never as
  something the rule caused.
- **Lineage.** Each use is reconstructed from records that already exist: the adaptation's rule,
  version and hash → the decision disclosure recorded in the `plan.candidates` operation → the
  candidate and plan identity that disclosure named → the plan's activation, step operations and
  audit records → the per-step verification outcomes → the plan assessment and its outcome evidence.
  Ids and content hashes from those records are the join keys; no id is invented and no record is
  rewritten. A use whose decision cannot be established is excluded with its reason rather than
  inferred from eligibility.
- **The comparison is a disclosure, not a baseline trial.** For every use the read states which
  candidate led before and after the rule, whether selection changed, whether execution followed,
  what verification reported, and whether a comparable unadapted outcome exists. The unadapted
  decision was a *disclosed* alternative that was not executed, so its outcome is reported
  `unavailable` and is never estimated, imputed, or manufactured. No baseline plan is created or run.
- **Classification is one closed state per adaptation.** Sixteen states, computed from the uses and
  the plan/assessment records: `not_approved`, `approved_never_applied`, `applied_outcome_pending`,
  `applied_successful`, `applied_partially_successful`, `applied_failed`,
  `applied_blocked_or_uncertain`, `applied_awaiting_confirmation`, `applied_insufficient_evidence`,
  `applied_conflicting_evidence`, `applied_mixed_outcomes`, `applied_not_changed`,
  `applied_unattributed`, `applied_to_earlier_version`, `retired_before_evaluation`, and
  `ineligible_support_invalid`. A `blocked` or `uncertain` outcome is never converted into a failure;
  a cancelled plan and a missing record are `insufficient_evidence`, not success; a use tied to an
  older rule version is `applied_to_earlier_version` rather than counted under the current one.
  Conflicting assessments are preserved as `applied_conflicting_evidence`.
- **The outcome vocabulary is closed.** Effective outcomes are `successful`, `failed`,
  `partially_successful`, `blocked`, `uncertain`, `awaiting_confirmation`, `insufficient_evidence`,
  and `conflicting_evidence`. Real-world success is never inferred from a successful execution alone:
  a use is only `successful` when the plan's own assessment established it, which for this plan model
  requires goal-criterion evidence.
- **Aggregates are counts, stated with their scope.** Each adaptation row carries raw uses and
  per-version counts, the outcomes observed under the adapted and unadapted attributions, the
  inclusion/exclusion counts, the read window, and the rule versions seen. The report separates the
  records from the summary and never invents a confidence percentage, success probability,
  significance test, or causal explanation. A sample under the thresholds stays explicitly
  `insufficient_evidence`.
- **Bounded and fail-closed.** The read takes at most 20 adaptations (`MAX_EFFECTIVENESS_ADAPTATIONS`),
  at most 100 uses in total (`MAX_EFFECTIVENESS_USES`), keeps at most 10 use samples per row for
  display while reporting the true counts, and scans at most 20,000 audit records (`MAX_AUDIT_SCAN`),
  saying which bound it hit. A damaged or unreadable store is a refusal, not an empty history: the
  same `StoreError` the other reads raise. The read re-runs itself to verify its digest, so a change
  between the two reads (an approval, a guidance change, a retirement, a new plan or assessment, a
  differently linked use) is reported as a failed verification instead of a stale report.
- **User-controlled review, not optimization.** The report may recommend *review* and may name
  `consider_retirement`; it cannot retire. Retirement remains `adaptation.retire`, rule changes remain
  `adaptation.guide`, and the read cannot approve, execute, retry, or change a plan, a goal, or a
  task. `authorizes` is `false` on every report, and the rendered display says the read approves
  nothing, changes no rule, retires no adaptation, and executes no task.
- **Tests and cost.** `tests/adaptation-effectiveness.test.js` (registered in `npm test`) covers the
  lifecycle states, lineage and version attribution, conflicting and insufficient evidence, damaged
  stores, bounded and concurrent reads, counterfactual limits, that approval is never treated as
  application or success, that a record cannot retire itself, and a deterministic end-to-end run
  (approve → influenced decision → separate plan approval → execution → verification → outcome →
  assessment → review → optional retirement → baseline decision restored).
  `benchmarks/run-effectiveness-benchmark.mjs` measures the **complete** verified request as the
  number of linked uses and stored adaptations grows, plus concurrent reads beside writes, with the
  partial store and audit reads printed separately and labelled partial. On this machine the complete
  request took a median 52.3 / 146.7 / 318.4 ms at 4 / 12 / 24 linked uses and 316.4 / 320.4 / 337.9 ms
  at 1 / 8 / 20 stored adaptations; the pure analysis was 27.5 / 71.4 / 167.6 ms. A target outside the
  newest-20 window was disclosed and not read. Observations of one machine at one time, not a
  specification.
- **What it does not claim.** No proven causality, no guaranteed improvement, no autonomous rule
  optimization, and no automatic retirement. An association between an approved rule and a later
  assessed outcome can have many other causes, including the user's own choices, and the report says
  so.

### How a governance review is bound to evidence (AP-05)

Batch AP-05 answers the question AP-04 can only raise. When the effectiveness report says an approved
record needs attention, a user can open a governance review against the exact evidence the stores hold
at that moment, inspect and reconcile it later, and record one of three lifecycle decisions. It adds
two record kinds to the existing experience store (`adaptation_review`, `adaptation_review_decision`),
one canonical evidence module (`experience/review.js`), one pure analysis module (`plans/governance.js`),
five actions, a controller surface and four CLI commands. It adds no store, no new authority, no
planner, no decision dimension, no execution path, and no second retirement mechanism.

- **The evidence is a canonical snapshot, not a live pointer.** A review cites the adaptation id and
  capability; the rule text, hash, version and shape; the adaptation's decision state, active/retired
  flags, support state, source and conflict ids; the report's availability, state, summary,
  recommendation and observations; the supporting, missing and superseded experience and feedback ids;
  up to 20 prediction/pattern refs; up to 20 uses with their recorded outcome; up to 20 plan and goal
  refs; and the read bounds. One function fixes field order and bounds, so two bundles compare by
  SHA-256 digest. Each reference list is separately capped at 20; the pattern is one reference. The report digest is recorded separately because it covers the whole report and can
  move while nothing the review cites changed.
- **Reader state is derived on every read, never stored.** Stored records are only the review and the
  user's decision; a stored status beside the evidence would be a second, editable copy of what the log
  already says. The closed vocabulary is `no_review_required`, `review_recommended`, `review_opened`,
  `review_awaiting_evidence`, `review_evidence_changed`, `review_completed`, `review_dismissed`,
  `review_decision_superseded` and `review_unavailable`. A review opened before the report could
  classify an evaluated use of the current version is `review_awaiting_evidence`, not success and not
  failure.
- **Three decisions, one existing retirement authority.** `keep_active`, `dismiss` and `retire` are
  user-origin writes. A decision is refused if the evidence changed after the review was opened - the
  user must reconcile first. `retire` appends the existing `adaptation_retirement` record through the
  existing `adaptation.retire` authority, then records the decision citing the pre-retirement evidence
  digest; a retired adaptation cannot be used or reviewed again, so the decision is terminal. Decisions
  are append-only and never rewritten; a later review supersedes an earlier undecided one.
- **Reconciliation names differences, not verdicts.** The reconciler re-derives the bundle and compares
  it item by item under a closed, ordered vocabulary: `unchanged`, `added`, `stale`, `conflicting`,
  `withdrawn`, `superseded`, `missing`, `unreadable`. `added` is not an improvement; `withdrawn`,
  `superseded` and `missing` are not a failure; a rule version change is `stale` while a rule hash
  change at the same version is `conflicting`; conflicting evidence stays conflicting; an item behind a
  truncated read is `unreadable`, never `withdrawn`; and a moved report digest alone is not an evidence
  change. A changed digest means reconcile before deciding, never better or worse.
- **Bounded and fail-closed.** At most 20 adaptation rows per list read (`MAX_GOVERNANCE_ADAPTATIONS`,
  the AP-04 bound), 20 evidence references per list, 20 reviews read per adaptation history, and 40
  change entries. A damaged experience or plan store raises `StoreError`; a missing plan store yields
  `review_unavailable` with its reason and a `null` reconciliation rather than an empty bundle. An
  audit-append failure after a decision is disclosed, and the decision the store already recorded is not
  erased.
- **Tests and cost.** `tests/adaptation-governance.test.js` (41 cases in 8 suites, registered in
  `npm test`) covers the nine states and three decisions, evidence identity, reconciliation precedence
  and every change kind, stale/conflicting/missing/unreadable evidence, model-origin refusal at the
  registry and the store, concurrent open/retire/reconcile, restart persistence, audit-append failure,
  damaged and missing stores, and two deterministic end-to-end paths. `benchmarks/run-governance-benchmark.mjs`
  measures the complete verified list/open/inspect/reconcile/decide path. On this machine the list
  request took a median 166.3 / 474.2 / 996.0 ms at 4 / 12 / 24 linked uses, open 151.7 / 445.1 / 640.1
  ms, inspect 338.7 / 667.0 / 1,231.2 ms, reconcile 240.9 / 632.5 / 1,160.7 ms, and decide 163.9 /
  345.8 / 608.5 ms; at 1 / 8 / 20 stored adaptations the list took 967.8 / 997.4 / 1,049.9 ms. At 21
  stored adaptations the target falls outside the newest-20 window and is not reported, which the
  report says. Observations of one machine at one time, not a specification.
- **What it does not claim.** Opening a review approves nothing, changes no rule, increases no
  influence, and executes nothing; a recommendation is never a decision. The read has no write path,
  and the write actions cannot approve an adaptation, change guidance, or run a plan. Reconciliation
  reports a difference, not a causal finding, a quality judgment, or real-world truth.

### A wrong expectation as one recommendation (AP-13)

The prediction ledger could state that an expectation ended as `contradicted`, and nothing downstream
read it. AP-13 adds the smallest consumer that closes that clause without turning a verdict into a
permission.

- **The read.** `PredictionStore.expectationCautions({ capabilities, limit })` loads the prediction
  ledger once, keeps only predictions in the caller's capabilities that are neither retired,
  invalidated nor unevaluated, and opens their horizons with the existing scoped projection. The
  derivation (`src/prediction/caution.js`) emits a caution only for a stored `contradicted` verdict
  that a fresh evaluation still confirms with a readable experience log. Everything else is withheld
  with its own reason (withdrawn, superseded, retired, no verdict, another verdict, stale with its
  `staleReason`, unreadable log) or reported unavailable; nothing is silently dropped. The bounds are
  fixed: 3 cautions, 8 capabilities, 4 withheld entries per read.
- **The only consumer.** `continuation/engine.js` attaches a caution to an approved, valid,
  not-yet-started plan whose step actions include the cautioned capability and replaces the
  recommendation `start-plan` (base 75) with `review-expectation` (base 62). The printed command is a
  read, `requiresAuthorization` is `false`, and the reasons state that the caution changed the
  recommended act, not any readiness state, approval or authorization. A stale plan keeps
  `review-plan`; revalidation outranks review.
- **Disclosure beside readiness.** `executive/readiness.js` accepts the same bounded read and appends
  factors beside the unchanged state; `renderReadiness` and `renderContinuation` print the caution
  line and the fixed note that the plan remains approved and startable. An unread caution read is
  disclosed as unavailable, never as an empty result. `controller.continuationReport()` reads once for
  its window and passes the result to both; `#planReadiness` does the same for one plan.
- **No new authority or storage.** No gate, approval, activation or authorization path consults a
  caution. A withdrawal, a supersession, a retirement, a matched verdict, a corrected experience that
  makes the verdict stale, or a capability the plan does not run all withdraw the recommendation on
  read. A model origin cannot write the expectation the caution rests on.
- **Tests.** `tests/expectation-caution.test.js` (38 cases), registered in `npm test`, covers the
  derivation, the read bounds, the ranking and readiness disclosure, and nine end-to-end cases through
  the assembled application including a restart and a corrupt ledger.

## 5. C. Evidence and memory architecture

### Stores

| File | Owner module | Record | Append-only? | Write coordination | How it is read |
| --- | --- | --- | --- | --- | --- |
| `memory.jsonl` | `memory/memory-store.js` | User facts, corrections, model conclusions | Yes | `WriterLock` (`memory.jsonl.lock`) | Reducer over records; `memoryWindow`/`getMany` annotate corrections |
| `knowledge.jsonl` | `knowledge/knowledge-store.js` | Triples, retraction/resolution events | Yes | `WriterLock` | Reducer; lifecycle and supersession annotations at read time |
| `conversation.jsonl` | `memory/conversation-store.js` | Turns with origin and verification flag | Yes | Append-only, no writer claim | Tail read; damaged log reported, not read as empty |
| `experiences.jsonl` | `experience/experience-store.js` | Audited operations, feedback, adaptations, lifecycle events | Yes | `WriterLock` | Reduced at read time; `evidenceSnapshot`/`evidenceIndex` for a horizon |
| `predictions.jsonl` | `prediction/prediction-store.js` | User expectations, verdicts, lifecycle events | Yes | `WriterLock` | Reduced; lifecycle and lineage derived |
| `goals.jsonl` | `goals/store.js` | Goal records and transitions | Yes | `WriterLock` | Reducer; short-id resolution |
| `plans.jsonl` | `plans/store.js` | Draft, revision, approval, activation, outcome events | Yes | `WriterLock` | Reducer; validity re-reads the live plan |
| `tasks.jsonl` | `tasks/store.js` | Tasks and steps | Yes | Task lock protocol (`tasks.jsonl.lock`) | Reducer; lock recovery refuses a recycled-pid holder |
| `world-model.jsonl` | `world/store.js` | Entities, facts, relationships, events, evidence refs, resolutions | Yes | `WriterLock` | Reduced at read time; conflicts kept |
| `operations.jsonl` | `operations/operation-log.js` | One audit line per operation, masked and minimized | Yes | Append-only, no writer claim | Tail read; `health()` reports damage |
| `proposals.jsonl` | `proposals/store.js` | Model proposals and user decisions | Yes | `WriterLock` | Reducer; status derived from the record and live state |
| `task-summary-queue.json` | `tasks/summary-queue.js` | Deferred summary intents | Replaceable JSON document | Its own lock | Read-modify-write under the lock |
| `session.json` | `session.js` | Current session id | Replaceable | None | Read at start |

All JSONL stores are append-only in normal operation. No store rewrites a line. Damage is preserved
and reported; a read that cannot parse a line says so instead of treating the line as absent. The
only rewrite-like operations are explicit lifecycle events appended as new records (correction,
retraction, resolution, supersession, revision).

### Evidence references

Evidence ids have the form `ev:<source>:<recordId>`. A reference is a pointer, never a copy of the
record. The retrieval layer reduces each record to a bounded shape carrying provenance, validity,
status, and relationships. A claim's lineage snapshot stores ids, kinds, states, and counts only —
no claim text, stored content, or prose — so a later re-assessment can name what changed without
reproducing what was said.

### Contradictions, retraction, supersession

- Knowledge conflicts and World Model conflict groups are read as disagreements; both sides are
  kept and cited. Nothing resolves them by recency, source rank, repetition, or model preference.
- Memory corrections append a successor that names the replaced record; the earlier record is
  preserved and annotated with the successor. `memoryWindow` and `getMany` agree on that annotation
  (the `getMany` defect found in AO-09 was that disagreement and was fixed at the store boundary).
- Knowledge retraction and resolution are lifecycle events; `lifecycleState` and `supersededBy` are
  derived at read time. A retracted record stops supporting a claim; the history remains.
- World Model retraction and supersession are later records. Reads mark the earlier record as
  historical; they never delete it.
- A claim whose cited record is retracted, superseded, or unreadable becomes `unverified` or a
  weaker state, never `unsupported` merely because the record is missing. Absence is not disproof.

### Provenance and integrity

Every record carries its origin and, where applicable, the operation that produced it. User-origin
writes are separated from model-origin writes at the registry; a model cannot register a write
action and cannot write these stores. Audit records are masked at the single append boundary
(`operations/operation-log.js`) and minimized (`output`, request content). The mask is a pattern
heuristic over what APEX persists and prints; it does not protect a request that leaves for a model
endpoint the user configured.

### Cross-store read windows and the integrity vocabulary (AP-06)

Several reports assemble one answer from more than one append-only store: longitudinal outcomes,
adaptation effectiveness, governance, and `evidence.integrity`. Each store read was internally
consistent, but a write between two of them could make the combination describe an instant that never
existed. AP-06 addresses that without adding a transaction.

- **A window is proved, not imposed.** `src/evidence/snapshot.js` records each contributing file's
  identity (`exists`, byte `size`, whole-millisecond `mtimeMs`) before the first read and after the
  last. A JSONL store only grows, so an unchanged identity proves no append happened inside the
  window; a changed identity is `concurrent_modification`, a statement about the read. The window
  holds no lock, cannot stop a writer, and does not detect a rewrite that preserves both size and
  modification time - the stores' content validation and hashes remain the authority there. Batch
  AP-07 later added a content digest to the identity by default; see below.
- **Retry is bounded and disclosed.** `runConsistentEvidenceRead` makes at most three attempts, only
  after `concurrent_modification`, never after `unverifiable`, and reports the attempt count. One
  write invalidates at most one window, so two concurrent appends (a record and its audit line) can
  retire at most two windows; the budget never grows with store size. A store read that throws
  propagates unchanged, because a failed read is not a concurrent write.
- **One read per label per operation.** `snapshot.read(label, fn)` memoises the read for the life of
  the window, so two reports assembled in one operation cannot disagree because one read the store
  twice. The cache is never persisted or shared across operations.
- **One closed vocabulary.** `src/evidence/integrity.js` defines ten ordered states - `valid`,
  `valid_bounded`, `missing`, `stale`, `conflicting`, `broken_reference`, `damaged_store`,
  `truncated_history`, `concurrent_modification`, `unverifiable` - and reports a bundle by its worst
  state. `valid_bounded` is still evidence; `missing` maps to a gap, `out_of_window` and `unread` to
  `valid_bounded` (a limit is not a negative fact), `missing` references to `broken_reference`, and a
  duplicate identity in one store to `conflicting`. Findings are disclosed up to 50 with untrimmed
  counts; the digest covers the state, counts and disclosed findings.
- **Nothing is repaired.** A finding is a statement about the records as they read. Rewriting,
  deleting or back-filling a record to make it disappear would destroy the evidence it describes.
  Every report carries `authorizes:false`; a valid digest proves the bytes have not changed, never
  that they are true or that an action is permitted.
- **The integrity read is one window over every configured store.** `evidence.integrity` runs each
  store's own health check where one exists and records the others by identity alone. `corruptLines`
  and `corrupt` are normalised to a count; knowledge `claims` plus `lifecycleEvents` are counted as
  records. `available` requires a consistent window and no `unverifiable` health check; damage stays
  available because it is a finding about records that were actually read. Its verification opens a
  second window and compares `available`, then the digest.
- **Consumers.** `adaptation.effectiveness`, `adaptation.reviews` and the review stages assemble
  inside one window and refuse a report that cannot be certified (`available:false` with `state` and
  `attempts`, no rows, `totals:null`; the review stages raise `StoreError`). Cognitive retrieval,
  world state and the prediction projection keep their per-store reads and per-source `unavailable`/
  `damaged` disclosure; they do not claim cross-store consistency, and AP-06 did not make them
  window-certified. The window wraps the same store methods those readers use - there is no second
  evidence store or index. (Batch AP-07 integrates cognitive retrieval, world state and the
  prediction projection; see below.)
- **Bounded reads disclose clipping.** `adaptation.effectiveness` reads one adaptation past its
  20-row window and reports `integrity.truncated` with `truncatedSources: ['adaptations']` when the
  extra row exists, so a full store and a captured window no longer look identical. The state becomes
  `valid_bounded`; the totals still report 20 read.

### Consumer-wide evidence consistency (AP-07)

AP-06 certified the reports that already assembled several stores, but the request path still read
cognition, world state and the prediction projection store by store, and a `stat`-based identity could
not see a same-size rewrite. AP-07 closes both without a second evidence system.

- **The identity carries the bytes.** `storeIdentity` hashes each contributing file (SHA-256) at both
  inspections by default (`content: true`); a digest difference is a change even when size and mtime
  agree, and `changeKind` names `deleted`, `created`, `appended`, `truncated`, `replaced`,
  `content_changed` or `touched`. `content: false` is explicit and certifies metadata only, and the
  verdict says so. The verification result is memoised for the life of the snapshot.
- **One ordered read contract.** `src/evidence/read-contract.js` defines nine states -
  `complete_empty`, `complete_nonempty`, `bounded_usable`, `truncated`, `missing`, `unavailable`,
  `damaged`, `inconsistent`, `unverifiable`. `readReport` applies the window verdict: an
  `unverifiable` window makes every source `unverifiable`, and a `concurrent_modification` window
  makes them `inconsistent`. `absenceProven` holds only for `complete_empty`; a bounded window that
  returned nothing proves no absence. Findings map onto the integrity vocabulary, and at most 32
  sources are reported.
- **Consumers read through the window.** Cognitive retrieval reads memory and knowledge through one
  content window and hands the verdict to `retrieveEvidence`, which reports the bundle as `cognition`.
  World state reads the experience temporal summary and the prediction prompt view through the same
  window; `certifyWorldRead` re-derives the read and never promotes completeness, so a record-limit
  cut stays `truncated`. `prediction.longitudinal` reads the ledger and the experience index in one
  window and withholds every pattern when the read is truncated or the window moved. `plan.candidates`,
  `plan.outcome`, goal assessment and the existing effectiveness and governance reads do the same. A
  pattern, projection or assessment that cannot be certified says so; none is silently downgraded.
- **A refusal is an outcome, not an input error.** `plan.assess` raises
  `EVIDENCE_WINDOW_UNCONFIRMED` when the evidence it re-derived was not provably unchanged. The target
  was well formed and the records moved, so the executor reports the execution as `failed` (the
  controller's `EXECUTION_FAILED`), records no assessment, and names the window state and what moved.
- **Reuse is per operation.** `snapshot.read(label, fn)` memoises one promise per label for the life
  of a snapshot. The benchmark measures two reads of one label inside one window at about one
  window's cost against two windows; nothing is persisted between operations.
- **Not universal consistency.** A window proves quiescence between two inspections; it is not a
  transaction, holds no lock, cannot stop a writer, and cannot see a same-size rewrite that is later
  restored. Stores with no health check are described by identity only. No consumer reads a verdict to
  authorize an action, and every report carries `authorizes: false`.

### Grounded response integrity (AP-08)

AP-07 made every contributing read certifiable. AP-08 adds no pipeline and no store: it makes the
existing request path describe itself, claim by claim, and states how far a model's prose may be
trusted. `src/cognition/response-integrity.js` is a pure module over what the path already produced.

- **A fourteen-stage contract, in order.** Request understanding, retrieval, claim extraction,
  contradiction detection, deliberation, grounding brief, model call, output validation, proposal
  validation, handoff preparation, authorization, execution, verification, finalization. Each stage
  names its owner and, where it can cross an authority boundary, that boundary; each records exactly
  one of `ran`, `ran_no_result`, `skipped`, `not_reached`, `unavailable`, `failed`. `reachedThrough`
  counts stages that executed, so a stage that was never reached, or whose inputs could not be read,
  never inflates it. A contract that paired a failed model stage with a grounded answer fails its own
  `grounding_precedes_final_answer` check.
- **Grounding is per claim, not per answer.** The structured reply already names an `evidence` id
  list and a `kind` per claim. The retrieval bundle already carries each evidence state. The contract
  joins them: supported, partial, conflicting, unverified, stale, retracted, superseded. A claim that
  restates a record it cites is checked lexically - content words only, digits as their own evidence -
  and is `attributed` at 0.6 overlap, `partial` between 0.5 and 0.6, and `unattributed` if its numbers
  do not appear in any cited record. A claim with no citation is `uncited`, and one whose record could
  not be read is `unknown`. None of these is a truth claim; they are statements about matching text.
- **Five trust states, and a ceiling.** `received`, `syntactically_valid`,
  `accepted_for_presentation`, `factually_supported`, `verified`. The ladder is monotonic, and the
  state is the highest rung that holds. `verified` is `ok:false` unconditionally: APEX checks that a
  citation exists and that the sentence restates it; it does not verify the sentence. A model that
  declares itself `verified`, `authorized`, `trusted` or `provenance`-bearing has its reply rejected by
  the existing structural validator, because those keys are not the model's to assert.
- **Degradation is deterministic.** `no_output` when there is no text to present; `present_as_is` only
  when every factual claim restates a cited, current record and the sole limitation is that model
  output is unverified; `present_with_limitations` otherwise, carrying a closed set of codes
  (`plain_answer_unstructured`, `structured_response_rejected`, `claim_attribution_unverified`, ...).
  The wording qualifies the answer; it never upgrades it. A reply rejected for a fabricated id reaches
  the reader as a plain answer with no citation, not as a citation failure discovered afterwards.
- **Audits are bounded and prose-free.** `responseContractAudit` and `responseIntegrityAudit` fix
  their key sets, clamp counts to non-negative integers, drop non-finite values, cap disclosed claim
  counts and limitation codes, and carry no request text, record text, prompt or reply. A proposal
  tally that is not a count is reported `unavailable` rather than read as zero.
- **A grounded answer authorizes nothing.** The contract's final stage and the handoff record are
  separate objects. A model proposal is revalidated against the live action registry at preparation
  from a live read; a plan activation is checked against the plan's content hash
  (`APPROVAL_NOT_BOUND_TO_PLAN`); a task run checks the task's own approval and state. Every handoff
  record names its authority owner and carries `authorizes:false`. A denial is still written to the
  operations log, so a refused crossing is auditable.

The contract is descriptive: the runtime still executes the path it always did, and the checks are
assertions about that path that the suite enforces. What AP-08 changes is that a reader can now see,
for one request, which stages ran, what each claim rested on, how far the answer may be trusted, and
who - if anyone - authorized a side effect. See `cognition-response-integrity.test.js` (42 cases,
including a 28-scenario acceptance table) and the AP-08 benchmark section.

### Semantic grounding and claim consistency (AP-09)

AP-08's attribution compares content words and digits. AP-09 adds a second, bounded comparison of
what the claim means relative to the records it cites. `src/cognition/semantic-consistency.js` is a
pure module; `response-integrity.js` calls it per claim and gates the existing ladder on it. No
store, action, dependency, pipeline or authority was added.

- **A closed thirteen-outcome vocabulary.** `semantically_consistent`, `partially_consistent`,
  `polarity_conflict`, `numerical_conflict`, `temporal_conflict`, `entity_conflict`,
  `relationship_conflict`, `qualifier_conflict`, `unsupported_transformation`, `ambiguous`,
  `insufficient_evidence`, `unavailable`, `not_checked`. A documented precedence reports one:
  `unavailable > not_checked > insufficient_evidence` and then `polarity > numerical > temporal >
  entity > relationship > qualifier > transformation > ambiguous > partially_consistent >
  semantically_consistent`. A conflict is never replaced by a weaker outcome, ambiguity is never
  support, `not_checked` is not success, `unavailable` stays unavailable, a partial reading stays
  partial, and no confidence score exists.
- **Eight dimensions, all bounded.** Attribution (readable, current, not withdrawn or contested,
  re-read per record), clause-scoped polarity and a closed antonym list, quantities (signs, percent,
  a unit-alias table with no conversion, bounds, precision, added/omitted values), temporal
  (formats, explicit ordering, stale and superseded, "not recorded" is not "did not happen"),
  entities (a sentence-initial capital is not a name), relationships (closed verbs, passive voice,
  subject/object inversion, equality), qualifiers (the quantifier and certainty ladders, hedges,
  uniqueness) and transformation (causal markers and added content).
- **Documented early outcomes.** A non-factual kind is `not_checked`; no citation is
  `insufficient_evidence`; a moved, damaged or unavailable window is `unavailable`; an inconsistent
  or unverifiable snapshot is `not_checked`; a withdrawn, stale or contested record is
  `insufficient_evidence`; a single shared content word is enough to run the dimensions; zero
  overlap is `insufficient_evidence`; with no dimension fired, coverage below 0.5 is insufficient,
  below 0.6 partial, otherwise consistent; a bounded read or an omitted value/date is at least
  partial. Every outcome also carries a fixed reason label.
- **Response-level consistency.** At most twelve claims and six pairs. Only factual claims are
  compared; polarity is compared for any pair, while numerical, temporal and qualifier mismatches
  require the two claims to share a content word, so unrelated facts are not paired. `overstated`
  counts supported claims that are not semantically consistent.
- **Conservative trust.** `factually_supported` now additionally requires every attributed factual
  claim to be semantically consistent and the response to have no contradictions. Any other outcome
  adds a closed limitation (`semantic_*`, `response_inconsistent`) and forces
  `present_with_limitations`; `present_as_is` still requires the single limitation
  `model_output_unverified`. `verified` remains `ok:false`. The reader gets a notice of finding
  labels and counts, never claim text, and the notice is not stored in the model's turn. The
  contract's stage 12 adds semantic claim, checked and conflict counts beside the structural status.
- **Observation, not authority.** A window failure that prevents the check is an evidence result,
  not an `execution_failed`; the late recheck still only weakens. The audit's fixed-key `semantic`
  block carries labels, counts, dimension statuses and at most six contradiction index pairs, no
  text, and `authorizes:false`. A semantic finding grants nothing: proposals still cross the live
  registry, and plan and task handoffs keep their existing approvals.

See `semantic-consistency.test.js` (88 cases, including the 28 deterministic attack classes),
`semantic-acceptance.test.js` (18 end-to-end cases through the real controller) and the AP-09
benchmark section.

### Retrieval quality, relevance calibration and omission disclosure (AP-10)

AP-10 adds no store, no pipeline and no index. It changes three things in the existing lexical
retrieval path and makes what the context budget removed visible.

**The defect that was measured, not guessed.** Both stores weight a query term by
`idf(t) = max(1, log(1 + (n - df(t) + 0.5) / (df(t) + 0.5)))` and score a record as
`matchedWeight / totalQueryWeight`. A term that occurs in *no* record has `df = 0`, so its weight is
`log(2n + 2)`: it grows without bound as the store grows, and it sits in the denominator of every
record's score. A record matching two of three query terms therefore scored 0.3486 at 20 records,
0.2501 at 200, 0.2083 at 1000 and 0.1820 at 4000 — crossing the fixed `PROMPT_RELEVANCE_MIN = 0.2`
floor between 1000 and 4000 purely because unrelated records were added. The record was still
retrieved and still ranked first; the floor silently discarded it. This was reproduced on both real
stores with three fixtures at four sizes before any scoring was changed
(`retrieval-scoring.test.js` pins the four before-values exactly).

**The fix is a calibrated cap, not a lowered threshold.** An absent term is rarer than any term the
store holds, but the store cannot establish *how much* rarer: "appears in no record" is the same fact
at 20 records and at 4000. Its weight is now
`max(rarestObservedIdf, min(termIdf(0, n), MAX_UNSEEN_TERM_WEIGHT))` with
`MAX_UNSEEN_TERM_WEIGHT = 4` (`src/retrieval/relevance.js`). Below the cap the AP-09 weighting is
reproduced byte-for-byte; above it the weight stops growing. When every query term occurs in the
store, nothing changes at all. The cap was calibrated on a measured interval: with one absent term of
three and every observed term ubiquitous, a cap of 8 is the largest that keeps a two-of-three match at
or above 0.2; with two absent terms of three, the cap must exceed 2 to keep a one-of-three match below
it. 4 is the geometric mean of `(2, 8]`. After the fix the same fixture scores 0.3333 at 1000, 4000
and 10000 records — size-independent — while a deliberately irrelevant one-of-three fixture stays
below the floor at every size (0.1180 at 20, 0.1111 at 1000). The precision the old score bought by
size-dependent accident is now bought deliberately.

**Normalization is shared and deliberately lexical.** `src/retrieval/normalize.js` owns the split for
both stores: lowercase, word separation, stopwords dropped, identifiers and dates kept whole, and
negations (`not`, `no`, `never`, `without`) kept as content so "not completed" and "completed" stay
different queries. The memory store stems word forms; the knowledge store does not. That divergence is
deliberate and preserved. `MAX_QUERY_TOKENS` is 4096, derived from `MAX_REQUEST_CHARS = 4000`: a
bounded request cannot yield more than about 2400 distinct content tokens, so the bound is a guard
against an unbounded direct store call rather than a routine truncation. Cutting a legitimate request
from the front discarded its informative tail and lost an exact match; `dropped` still reports any
truncation so a shortened query is disclosed rather than silently searched as a prefix. Identifier-like
tokens are excluded from fuzzy matching: `similarity("ap-10", "ap-11") = 0.667` and
`similarity("2026", "2027") = 0.6` both exceeded the 0.6 fuzzy floor, so a query for one identifier
could retrieve a different one.

**What the context budget removes is now stated.** `buildPrompt` collapses knowledge records that
repeat an identical subject-relationship-object triple, counts the collapse, and says so. Records cut
by the size budget are counted and disclosed, and an emptied knowledge section renders as a disclosure
rather than as silence. A disagreement survives the budget: the per-record `[contested: ...]` marker is
decided from the *untrimmed* conflict list, so cutting the tail can never turn a contested claim into
an apparently unopposed one. The omission note is chosen from a three-form ladder, shortest first while
the budget is being spent and upgraded afterwards only into room that is actually left. This follows
the existing rule for derived-section notices: a disclosure may never be the reason a record that
answers the question is dropped. The full sentence is longer than a short knowledge line, so rendering
it unconditionally made each trim step *grow* the prompt and emptied the section to pay for the note.

**Known weaknesses, stated rather than hidden.** A long query dilutes its own score: the denominator
sums every query term, so 380 unrelated words plus three relevant ones score an exact match at about
0.0055 and the prompt floor excludes it even though the store retrieved it and ranked it first. The
record is not lost — it is still returned by `search` and still citable — but it does not enter the
prompt. This is a property of the coverage-ratio score, not of store size, and it is reported as
`below_relevance_threshold` rather than as "no match". Thresholds were not lowered to hide it.
Retrieval remains bounded lexical token overlap: it is **not semantic understanding**, not entailment
and not natural-language inference. A synonym absent from the record text, a paraphrase, an implication
or a coreference is not resolved, and no such capability is claimed.

**One retrieval report, eleven ordered states.** `src/retrieval/report.js` describes every evidence
read with the same vocabulary AP-07 uses for the read itself, extended to say what retrieval *did*
with the window: `complete_empty`, `complete_with_results`, `not_searched`,
`below_relevance_threshold`, `bounded_results`, `source_limit_reached`, `context_budget_limited`,
`incomplete_source`, `unavailable_source`, `damaged_source`, `inconsistent_snapshot`. The list is
ordered least to most limiting and the aggregate is the worst source, so two readers cannot disagree
about whether a retrieval that lost records to a bound was "complete". Per source the report carries
identity, read state, search status, returned/matched/eligible counts, the three exclusion kinds
(below the relevance floor, beyond the source limit, cut by the context budget), whether completeness
was established, and how many records contributed evidence. An unreadable source reports `null`
counts, never `0`: zero would turn an unknown into an absence. `absenceProven` is reused from the read
contract and is true only for `complete_empty` — a bounded window that returned nothing proves neither
completeness nor absence. A `concurrent_modification` or `unverifiable` window forces
`inconsistent_snapshot` on *every* source and blocks the aggregate, because the stores were read at
separate instants and nothing here claims an atomic multi-store transaction. The report is built from
the coordinator's own records and finalized purely once the prompt budget is known; it grants no
authority (`authorizes: false`) and the persisted projection carries counts and states only, never
record text, query terms or store error detail.

**Citation completeness is assessed against the same snapshot.** `assessCitationCompleteness`
(`src/cognition/response-integrity.js`) checks, per claim, that every cited evidence id was actually
retrieved, preserves each cited record's lifecycle (`current`, `historical`, `superseded`,
`retracted`), names a relevant retrieved record that no claim cites, and detects reliance on one side
of a stored disagreement whose other side was retrieved and uncited. Relevance is only establishable
from the lexical score the search assigned, so a record without a score is never flagged: the check
can neither force a citation nor imply an uncited record was irrelevant. A response with **no claims**
has no citation behaviour to assess, so nothing is flagged there; the trust ladder already states its
grounding and cannot reach `factually_supported` without a factual claim. A one-sided reliance replaces
a `semantically_consistent` or `partially_consistent` finding with `insufficient_evidence` and keeps
any more severe finding the semantic check already reached. Three fixed limitation codes
(`citation_relevant_uncited`, `citation_one_sided_conflict`, `citation_outside_snapshot`) and a
bounded disclosure notice carry the result beside the answer; the audit stores counts only, so an
audit record can never name a stored record.

**Measured behaviour of the one-sided check, stated plainly.** Through the real controller a factual
claim (`supported`, `partially_supported` or `historical`) that cites one side of a retrieved,
unresolved disagreement is *always refused by the AP-08 structural validator before the citation
assessment runs* — `claimStateProblem` rejects the label and asks for both sides or `unknown`. This
was verified for memory records, knowledge triples and world-model facts, all of which receive
symmetric `contradicts` links from `extractClaims`. Consequently `citation_one_sided_conflict` is a
defence-in-depth layer: end to end it is reachable only where a conflict is recorded in the projection
but not on the records themselves, and the §7 suite drives that case at the assessment boundary. This
is a stronger guarantee than §7 requires, not a gap — but it means the code does not fire on the
ordinary request path, and the refusal notice (`[Stored context contains conflicting records; …]`) is
what the user actually sees. A related consequence: because a refused structure contributes no claims,
the claim-level `evidence_conflicting` code cannot fire on that path either; the disagreement is
disclosed by the notice instead. Both paths disclose, neither hides.

See `retrieval-scoring.test.js`, `retrieval-context-budget.test.js`, `retrieval-quality.test.js`,
`retrieval-report.test.js`, `citation-completeness.test.js`, `retrieval-adversarial.test.js`,
`retrieval-snapshot.test.js`, `retrieval-acceptance.test.js` and
`benchmarks/run-retrieval-quality-benchmark.mjs`.

### Derived lifecycle state reuse (Batch AP-11)

One request reads the same knowledge snapshot several times — the world-state projection, the prompt
projection and the retrieval search each derive lifecycle state from it. Before AP-11 every one of
those reads rebuilt the supersession map, the conflict index and the resolution index over **all**
claims, and `projectionRead` rebuilt the store-wide health summary as well. The measured cost was
attributed per leaf method, not assumed: at 1,000 records `knowledge.projectionRead` was the largest
single contributor to a warm request, and the executive `list`/`load` pairs, duplicate lexical search
and the traced cognition stages were each ruled out by measurement.

**The key is content, not size.** `JsonlStore.load()` accepts an optional caller-owned `certification`
object and writes into it the SHA-256 of the exact bytes the returned records were parsed from — the
same digest the AP-07 parse snapshot already compares. The returned `{records, corrupt}` shape is
unchanged. A read that did not establish a digest (the store is larger than the parse cap, snapshot
maintenance was declined, or this instance just wrote the file) certifies `null`.

**One entry per store instance.** `KnowledgeStore` holds at most one `{key, indexes, health}` entry. A
different key replaces it; a `null` key drops it. It is never persisted, never shared between stores or
processes, and never bounded by a record count or a file size, so a same-length rewrite of the same
number of records misses it.

**What is reused and what is not.** Reused: `supersededByMap`, `conflictIndex`, `resolutionIndex` and
the store-wide health summary, across `list`, `search`, `projectionRead`, `health`, `findByPrefix` and
`byOperation`. Not reused: the claim list, which is re-split from the records of the current read on
every call, so a returned record is always that read's own exclusive copy; every write path, which
still derives its decision from the authoritative log under the write lock; and `history()`, whose
chain report is built from the derivation's own record objects and which is an explicit single-record
inspection rather than a repeated request-path read. The indexes always cover every claim — only the
returned window is bounded, so a conflict partner outside the window is still named.

**Nothing mutable escapes.** `annotate` copies the supersession and resolution arrays it hands out, and
the health summary is handed out as a clone, so a caller editing a result cannot reach the entry and
the entry cannot reach a later caller.

**Fail-closed.** A corrupt line means no certification: the derivation is rebuilt, nothing is retained,
`projectionRead` reports `damaged` with `claims: null`, and the complete-only readers still refuse. An
interrupted write therefore cannot be answered from an entry built before the damage. A concurrent
writer changes the bytes, which changes the key, which misses.

`lifecycleIndexStats` reports `cached`, `builds`, `hits`, `misses`, `healthBuilds`, `healthHits` and
`authorizes: false`. Like `parseCacheStats` it describes a performance aid, never stored state: a hit is
not an assertion that the store is healthy, and no decision about a record may be taken from it. No
persistence schema, record semantics, authorization rule, audit field or provenance link changed, and
no disk index or cross-process cache was added.

**Measured effect.** On the corrected benchmark the reuse removes one index construction and one health
derivation per unchanged snapshot (`builds 1, hits 3, misses 1; health builds 1, hits 1` over two
requests, at every size). The end-to-end change is smaller: a paired A/B on one corpus measures -0.6%
at 1,000 records and -7.6% at 4,000 with an identical answer surface, and at 10,000 the warm median is
within run-to-run drift (3,513.6 ms before, 3,527.8 ms after). The request remains dominated by
whole-store work that is not derived state — whole-log loads and record copies, the two searches that
tokenize every record, and the window annotation — which is why the reuse does not reach the sub-second
target at 10,000 and why no persistent index was added.

See `knowledge-lifecycle-reuse.test.js` (equivalence against a fresh instance, one construction per
unchanged snapshot, append/retraction/resolution/supersession invalidation, same-length replacement,
a concurrent writer, snapshot movement, interrupted and damaged stores, partners outside the window,
cold start, two application instances, a write from another OS process, caller-edit isolation, and the
real controller path) and `benchmarks/run-runtime-performance-benchmark.mjs`.

### Request-scoped read reuse and retrieval token reuse (Batch AP-12)

AP-11 removed one repeated derivation per read. AP-12 removed the two costs that remained between the
derivation and the answer: **a full deep copy of every record on every read**, and **re-tokenizing the
whole store on every search**.

**The parse snapshot now shares frozen records.** A `JsonlStore` snapshot hit used to return a deep
copy of every record and every nested field, once per read. One request reads knowledge and memory
several times over one snapshot, so that copy was paid several times for bytes that had not changed.
A hit now returns the snapshot's frozen records in a new list: pushing or sorting the list a caller was
handed cannot reach the snapshot, and editing a record field throws instead of silently diverging from
the file. A miss freezes the records it parsed, to the depth `loadForAppend()` has frozen records since
Batch V. A store over the parse cap, or a read that this instance's own append just invalidated, still
returns ordinary records exactly as before. The AP-07 copy-per-hit assertion became a frozen-record
assertion in `world-state-performance.test.js`: the safety property is immutability, not duplication.

**Retrieval corpora are keyed by the certified content hash.** `MemoryStore` retains at most one
`{key, corpora}` entry holding up to two corpora — one with private records, one without — each a pool,
one token set per record and the prebuilt fuzzy index. `KnowledgeStore` retains one `{key, corpus}` with
the active claims and their token sets, keyed like the AP-11 lifecycle entry and derived from it. The
key is the SHA-256 that the read itself certified, so a corpus can only describe the records that read
returned. A read that certified nothing (store over the cap, uncertified read, the read immediately
after this instance's own append, a damaged store) neither reuses nor retains. Two concurrent searches
for different `includePrivate` scopes share the content key but never each other's corpus.

**Group annotation is derived once per group per derivation.** `annotate` normalised every triple in a
conflict group and sorted every id in it once per annotated record. A 4,000-claim group and a twenty
record window cost 80,000 normalisations and twenty sorts of 4,000 ids for one read. Those derived
values are now memoized in a `WeakMap` keyed by the group array itself, which the lifecycle derivation
owns and replaces when the content key changes — so the entry lives exactly as long as the derivation
that produced it and cannot outlive its records. The claim-set key is built only when a resolution index
has entries, because an empty resolution map can match nothing.

**What is not reused.** The record list around a snapshot, always; the returned window, which each call
recomputes from the current records; scoring, document frequencies, fuzzy scoring, tie-breaking,
deduplication and the per-source bounds, all of which run exactly as before over the shared token sets;
the conversation, operations and task stores, which are not snapshotted at all. Retrieval results are
never shared between different queries, bounds, scopes or snapshots — only the tokenized corpus and the
derived lifecycle state are, and both are functions of the certified bytes alone.

**Reuse lifetime and its bound.** One entry per store instance, per process, for the life of the
instance or until the content changes: one parse snapshot, one lifecycle entry, one knowledge search
corpus, at most two memory corpora. A request performs one search per store, so releasing the corpora at
the end of each request would rebuild them for the reply re-check and again for the next request; the
content hash, not the request, is what makes a later read safe to serve. Nothing is persisted, shared
across processes, or written to disk, and a concurrent writer changes the bytes, which changes the key,
which misses.

**Fail-closed.** Damage certifies nothing: the memos are dropped, `projectionRead` reports `damaged`
with a null record list, the complete-only readers still refuse, and an interrupted append cannot be
answered from a corpus built before the damage. `retrievalIndexStats` reports `cached`, `builds`,
`hits`, `misses` and `authorizes: false` on both stores, like `parseCacheStats`; a hit is never an
assertion about a record.

**Measured effect.** The `compare` phase of `benchmarks/run-runtime-performance-benchmark.mjs` runs
the pre-AP-12 tree (extracted with `git archive`) and the current tree through the same driver over
identical, count-verified corpora, alternating side order per round. Warm request time fell from
35.7 to 33.4 ms at 20 records (0.95x), 60.0 to 47.8 ms at 200 (0.80x), 161.9 to 93.2 ms at 1,000
(0.58x), 656.3 to 298.4 ms at 4,000 (0.45x, 2.20x) and 1,625.2 to 715.0 ms at 10,000 (0.44x, 2.27x);
median-of-round-medians, one machine, one run. Cold-start times fell from 0.99x to 0.54x over the
same ladder, so the reuse helps a first request too, less so. Both sides return the same trust,
retrieval-completeness and verification states at every size. The saving tracks store size because
the removed work was proportional to the store; at 20 records there is little to remove. The stage
trace covers about 1% of a warm 10,000-record request, so the gain is not attributable to any single
traced stage — it is the whole-store reads, copies and tokenization beneath them. Full tables,
per-stage, query-shape and source-limit measurements, and the measurement rules are in
`benchmarks/README.md`.

See `request-scoped-reads.test.js` (frozen records and per-read lists, same-length rewrites, deletion
and recreation, cross-instance append and retraction, conflict resolution re-annotation, private-scope
separation, cold-versus-reused equivalence including diagnostics and conflict partners, oversize and
damaged stores, interrupted append residue, `getMany` supersession, concurrent reads) and
`benchmarks/run-runtime-performance-benchmark.mjs` phase `compare`.

### Cross-store belief tracing (Batch AP-14)

Every World Model fact, relationship and event already stored the memory and knowledge records its
evidence cites. AP-14 adds the reverse read, without a new store, a schema change, an inference, or a
second authority.

- **The index is derived, not persisted.** `buildCitationIndex(state)` scans the already-reduced world
  state once and maps `${sourceType}\u0000${sourceId}` to the statements whose evidence carries that
  reference. `statementsCiting(state, {sourceType, sourceId, at, limit})` returns a bounded window
  (`MAX_CITATION_REFS = 100`) ordered live-first. The relation comes from the stored evidence entry;
  no text similarity, model, or new relation type is involved.
- **A trace answers one direction without pretending to know the other.** For a world statement it
  lists each evidence reference and the owning store's current reading of it; for a memory or
  knowledge record it lists the world statements that cite it and whether each supports, contradicts
  or merely qualifies. `traceBelief()` is pure and always returns `authorizes: false`. Its dispositions
  are `supported`, `contradicted`, `withdrawn`, `superseded`, `historical`, `uncited`, `qualified`,
  `proposed`, `stale_evidence`, `unverified`, `unknown` and `missing`.
- **An unreadable store is not an empty one.** `MemoryStore.traceMany()` is fail-closed: a corrupt line
  refuses the whole trace. A reference whose store cannot be read is `UNREADABLE` and the world trace
  becomes `unverified`; a reference that no longer exists is `MISSING`; a record that exists but has
  been corrected is `NOT CURRENT: superseded` and the citing statement becomes `stale_evidence`.
  A citation from a store that does not hold the record is `unknown`, never `missing` and never
  silently accepted.
- **Retrieval sees stored cross-store contradictions.** `linkCrossStoreCitations()` reads the same
  citation index during cognitive retrieval. When a live world fact, relationship or event cites a
  memory or knowledge record with relation `contradicts`, the world statement is added as evidence
  with a reciprocal `relationships.contradicts` entry, so claim extraction pairs the two claims and
  response validation sees both sides. Supports, qualifications and retracted statements add no link;
  an unreadable memory store adds none; a link is never presented one-sided.
- **Nothing is decided.** The trace keeps both sides, names the sources, and prints its own closing
  line that it decides nothing. It approves, retracts, supersedes, prefers, and authorizes nothing,
  and it changes no store file (measured in `capability-inventory.test.js`). The same-store memory
  conflict it reports remains the existing clause heuristic and is labelled as such.
- **Bounds and tests.** 100 citations, 100 evidence references, 12 contradiction links per evidence
  entry; the citation count and a truncated list are disclosed. `belief-trace.test.js` (18 tests)
  covers both directions, contradiction, same-store disagreement, missing versus inconsistent records,
  correction and stale evidence, unreadable and damaged stores, a second process, repeat determinism
  with zero data-store writes, bounds, model-proposed records, retraction, secret masking, the
  cognition link and the CLI. No test contacts a model; none is evidence about a real model.

### Historical belief reconstruction (Batch AP-15)

The World Model already replayed its log to a cutoff and AP-14 already traced across stores. AP-15
joins them: a cutoff replays only records stored at or before it, then judges *validity* at that
instant, and the past answer is returned beside - never merged with - the current standing and the
changes recorded later. No store, schema field, persisted index or model call is added.

- **Two times, one replay.** Stored time (`recordedAt` / `.at`) decides what existed at the cutoff;
  valid time (`validFrom`, `validUntil`, `occurredAt`, `observedAt`) decides whether the statement
  was in force then. `stateAt(records, knownAt)` filters on stored time inclusively, then
  `reduceRecords` derives the state. A record written after the cutoff is absent from the past
  view; it is never used to pretend the system knew something earlier.
- **The reconstruction is a closed reading.** `validityStanding()` returns `in_force`,
  `not_yet_valid`, `expired`, `occurred`, `not_yet_occurred` or `unknown`; the interval is
  half-open, so `validUntil == cutoff` is expired. `reconstructBelief()` reports each statement's
  status and validity, counts believed / not-yet-valid / expired / conflicting / other, and caps
  the list at 100 rows with the omission disclosed. A statement counts as believed only while its
  status is `supported`, `contested` or `conflicting` **and** its validity is `in_force` or
  `occurred`; a conflicting statement is still a belief and is not silently dropped.
- **One certified read, two answers.** `WorldModelStore.historicalView(knownAt)` derives the replayed
  state, its belief reconstruction, the current state, and the later change window from the same
  read, so an append between reads cannot split the past from the present. The current view and the
  later window are produced only when the cutoff is at or before the application clock; otherwise
  the window is empty and that is stated rather than reported as a reversed range.
- **Per-store as-of reads where the semantics exist.** `MemoryStore.traceMany(ids, {at})` filters on
  `createdAt` and rebuilds replacement and conflict grouping from the records known then;
  `KnowledgeStore.getMany(ids, {at})` rebuilds lifecycle, supersession, conflict and resolution
  indexes from claims recorded by the cutoff, so a resolution recorded later does not rewrite what
  the earlier claim conflicted with. An id recorded only after the cutoff is `recordedLater`, not
  missing. Experience, prediction, task and operation evidence keep their own clocks and expose no
  certified historical read; at a cutoff they are `as_of_unavailable` and the trace is `unverified`
  rather than borrowing the present.
- **The trace names the condition.** `world.belief.trace` with `at` returns `mode: historical`,
  `asOf {cutoff, records, excluded, problems}`, the replayed disposition, a separate
  `current {cutoff, found, status, disposition, reason}`, and `laterChanges {from, to, changes,
  total, truncated, note}`. Validity-aware dispositions are `not_yet_valid`, `expired`,
  `not_yet_occurred` and `not_yet_recorded`; an unavailable or not-yet-recorded reference makes the
  trace `unverified`. A correction, retraction or supersession recorded after the cutoff lives only
  in `laterChanges`.
- **Strict instants.** One `parseIsoInstant()` accepts a date or a date-time with an explicit zone,
  normalizes to UTC, and rejects impossible dates (`2026-02-30`), out-of-range components and
  zone-less local times at both the action and the store-level reads. A cutoff is never guessed.
- **Bounds, read-only, no authority.** 100 reconstructed statements and 100 later changes per read;
  truncation is disclosed. The replay, the trace and the current view write no store file (pinned in
  `temporal-belief.test.js`), decide no disagreement, and return `authorizes: false`. The tracer
  over-approximates its confirmation across two reads by masking only the two read instants - the
  instant of the current view and the end of the later window - never a record, citation or status.
- **Tests.** `temporal-belief.test.js` (18 tests) covers recorded-before-valid-from, later-record
  exclusion, expiry, contradictory statements on different days, event observation boundaries, a
  missing valid-from, a cutoff after the present, retraction, supersession, memory correction,
  knowledge conflict and supersession as-of, prediction evidence and damaged stores, offset and
  date-only cutoffs, rejected malformed timestamps, read-only determinism, and cross-process and CLI
  reads. No model is contacted.

### Cross-store cognitive history (Batch AP-16)

AP-15 answered a cutoff for world statements and for named memory/knowledge records. AP-16 answers it
for the three stores that hold a whole lifecycle each - experience, predictions and the world model -
in one read, so "what had APEX recorded by this cutoff?" is a single certified answer instead of three
unrelated ones. Each store keeps its own record model and vocabulary; the shared part is the cutoff
contract, not a forced schema.

- **Reuse, not a second temporal stack.** The cutoff goes through AP-15's strict `parseIsoInstant`;
  the experience and prediction replays are the stores' own `historicalView()`; the world replay is
  AP-15's `WorldModelStore.historicalView()`. `reconstructCognition()` in `src/history/reconstruct.js`
  only orchestrates and shapes rows.
- **One certified window.** The three store reads run inside `runConsistentEvidenceRead` (AP-07), so
  the combination describes a quiescent window, the retry is bounded, and each store is read once per
  attempt. The prediction replay is judged against the *replayed* experience log; when the experience
  source cannot be read, an explicit `null` snapshot makes open horizons `evidence_unavailable`
  rather than consulting the live log.
- **Lifecycles stay separate.** Experience: a correction, feedback or review written later is
  `excluded` from the past view and flagged `correctedLater` / `feedbackAddedLater`. Predictions:
  status and decision as of then; an evaluation, withdrawal or replacement recorded later is
  `evaluationRecordedLater` / `invalidatedLater` / `supersededLater`, so a prediction evaluated after
  the cutoff is never reported as evaluated before it. World: AP-15's replayed counts plus the later
  change window summarized by kind. Each section also carries a `current` block read at the read
  time; the past and current answers are never merged.
- **Citations are resolved at the cutoff.** A prediction's cited experience/feedback ids are
  `recorded` (with supersession as of then), `recorded_later` (with the reason it was not evidence),
  `missing`, or `unavailable` when the source could not be read - an unreadable source never becomes
  `missing`.
- **The boundary is part of the answer.** At AP-16, goals, plans and tasks carried a recorded `.at` and
  a pure reducer but no cutoff read; the operations audit log has no recorded-at field and is appended
  only on completion; memory and knowledge expose id-based as-of reads, not a bounded as-of listing.
  All six were listed in `unsupported` with a reason instead of being approximated. AP-17 now answers
  the three executive logs and classifies the audit log; AP-18 answers the memory and knowledge
  listings.
- **Statuses and verifiability.** `asOf` reports the snapshot state, `complete`, `verifiable`, the
  attempt count, and per-source statuses (`read`, `absent`, `not_configured`, `unavailable`,
  `damaged`) with reasons. A damaged or uninspectable source is named, the other answers are still
  returned, and `verifiable` becomes false: a certificate proves the files did not move, not that a
  file that could not be parsed was read.
- **Bounds, no authority.** 20 rows per source by default, 50 at most; 40 citations; 10 later world
  changes; every bound reports `total` and `truncated`. The action is read-class, user and model
  origins, `plannable: false`; it writes no store, calls no model, and returns `authorizes: false`.
  The independent verifier re-runs the reconstruction and masks only `readAt` and the attempt count.
- **Tests.** `history-reconstruction.test.js` (18 tests) covers a prediction recorded before and
  after the cutoff, evaluated after it, and invalidated after it; feedback and a correction written
  later; a citation to a later record; a later cutoff; damaged experience and prediction stores; a
  ledger line with a missing or malformed stored time refused as damage; a cross-process append; a
  store moving during the read; bounds; repeat determinism; offset/date-only equivalence and
  zone-less refusal; the CLI read and its usage refusals; and one store read per attempt. No model is
  contacted.

### Historical executive state (Batch AP-17)

AP-16 named the goal, plan, task and operations stores as sources its cutoff read could not answer
for. AP-17 answers them through the same action, without a second history surface: `history.reconstruct`
(CLI `history --at`) now replays the three executive logs to the cutoff and classifies the audit log
against it, beside the experience, prediction and world sections AP-16 already returned. No store,
schema field, index or action was added, and the read remains one content-certified window with the
same bounds and `authorizes: false`.

- **One action, more sources.** `src/history/executive.js` shapes the new sections; `reconstruct.js`
  reads each executive store through the store's own `historicalView(cutoff)` inside the existing
  `runConsistentEvidenceRead` window. `supportsCutoff` is true for goals, plans and tasks and false
  for operations, and the nine sources are listed in one `asOf.sources` array.
- **Goals.** The replay is the goal reducer over events with `.at <= cutoff`. A row carries its
  recorded status, request, revision, per-criterion `basis` (`user_stated`, `system_inferred`,
  `assumption`, `verified_fact`), `requirement` (`required`, `suggested`, `declined`), evidence
  counts and cited operation ids, the completion record (criterion-to-operation pairs and declined
  criteria) and links. A completion, cancellation, supersession, revision, criterion decision or
  evidence record written later is absent from the past row and reported beside it
  (`statusChangedLater`, `stoppedLater`, `completionRecordedLater`, `revisionAdvancedLater`,
  `evidenceAddedLater`), with a separate `now` block. A completion citation is resolved to an audit
  record's existence and status, never to the truth of the evidence.
- **Plans.** The reducer keeps the version that was current at the cutoff, so a row reports that
  version, its status, content-hash-bound approval, activation, step outcomes and assessments as of
  then; a later approval, activation, revision, status change, outcome or assessment is a `later`
  flag plus a separate `now` block. `approval.usable` is always false: a historical approval records
  what the user authorized then, and running the plan today revalidates version and content hash.
  A revision after the cutoff therefore cannot lend its approval to the older version, and a later
  approval cannot authorize the earlier one.
- **Tasks.** A task is reconstructed from its own event log: status, step statuses, step counts,
  progress and recorded step outcomes at the cutoff. `interruptedAtCutoff` is true for a running or
  paused task and for a task holding a running, uncertain or awaiting-approval step. A completed step
  appears only with the outcome the log recorded (for example `verification_unavailable`), never
  promoted to success; the read never resumes, retries or executes anything.
- **Operations cannot answer a cutoff and say so.** The audit line carries `requestedAt` and
  `finishedAt`, no recorded-at, and is appended only at finalization. The section is a current read
  (`supportsCutoff:false`, `recordedAtKnown:false`) with each row classified: `later` when the latest
  of its two timestamps is after the cutoff (it provably did not exist then), `finished_by_cutoff`
  when it finished by then (whether the line was written by then is not recorded, so
  `existedAtCutoff` is `unknown`), `unrecorded_finish`, or `unknown`. A missing line is never read
  as success.
- **Citations across the executive rows.** Every operation id named by a displayed goal, plan or task
  row is resolved against the audit log: `finished_by_cutoff`, `later`, `missing` when no line parses
  and none is corrupt, `unavailable` when the log was not read or contains unreadable lines (absence
  unestablished), and `unknown`. A record stored by the cutoff that names an operation finishing after
  it is reported `later`, `inconsistent: true`, and is not used as past evidence.
- **Cutoff-subsequence integrity.** `historicalView()` still replays the whole log first; a damaged
  file is `damaged`. A full log that applies while its cutoff subsequence does not (a non-monotonic
  clock can produce this) makes the source `inconsistent`, names the reducer problems, and never
  reorders events to make them fit. The other sources keep answering.
- **Bounds and persistence.** Rows share the AP-16 bound (20 default, 50 maximum) and citations stay
  at 40; each section reports `total`, `truncated` and its counts. The persisted copy of a result is
  produced by the shared audit redaction, whose depth cap was raised from 8 to 10 because a bounded
  history row nests evidence ids four levels below the result payload; without that, the audited copy
  would disagree with the read it records.
- **Tests.** `executive-history.test.js` (34 tests) drives the real stores, controller and CLI:
  goal completion, cancellation and supersession after a cutoff; a completion recorded by the cutoff
  with a declined inferred criterion; plan approved after it, approval invalidated by a later
  revision, a later draft revision and a later assessment; a failed plan replaced later; a task
  started before and completed after, and an interrupted step with an uncertain effect; an operation
  finished later, one finished unverified, and a verification recorded later; citations that are
  missing, unreadable and inconsistent; a damaged goal log, a cutoff subsequence that does not apply,
  a store moving during the read; a cross-process append; determinism, bounds, adversarial input,
  model-origin refusal of writes, and the CLI listing. No model is contacted.

### Historical memory and knowledge reconstruction (Batch AP-18)

AP-16 named memory and knowledge as the last sources its cutoff read could not answer with a
bounded listing. AP-18 adds both sections to the same `history.reconstruct` action and `history --at`
CLI, through each store's own existing `historicalView(cutoff)`. No action, store, schema field or
index was added, `unsupported` is now empty, and the read remains one content-certified window with
the same bounds and `authorizes:false`.

- **One timestamp, two record models.** Both stores carry only `createdAt`, the time the record was
  appended, and a cutoff is applied to that field - never to file order and never to an event time
  that does not exist. `src/history/memory-knowledge.js` shapes the sections and keeps the lifecycle
  difference visible: memory has no retraction or conflict event, while knowledge has append-only
  retraction and resolution events and a successor-stored supersession link.
- **Memory.** The past listing is the store's derivation over records with `createdAt <= cutoff`: the
  earlier claim keeps the status the earlier record set implied (`user_confirmed`, `model_proposed`,
  `superseded`, `unresolved_conflict`, `stored`), and a correction written later is absent from the
  rows and reported as `later.replacedLater` / `later.conflictChangedLater` /
  `later.standingChangedLater` with a separate `now` block. Multiple corrections across cutoffs
  therefore produce a different, coherent answer at each cutoff. Conflict groups are the store's
  read-time clause-rule groups, not recorded events, and a later correction cannot clear a past
  disagreement retroactively. Private records are excluded from rows and disclosed by count only,
  because the reconstruction may be produced for a model origin.
- **Knowledge.** Claims and both lifecycle event kinds are filtered by `createdAt` before deriving,
  so a later retraction, supersession or resolution cannot apply backwards: a claim retracted later
  still existed at the cutoff, and a conflict unresolved then stays unresolved when a resolution
  arrives later. A resolution recorded by the cutoff is a recorded user decision at that time, never
  proof the chosen claim is true. A successor recorded later does not retroactively replace the
  earlier claim. Triple hashes and record identity are displayed as stored, not re-derived.
- **Evidence and citations.** `provenance.operationId` on either store is resolved through the
  existing operation-citation section; a record stored by the cutoff citing an operation finishing
  later is reported `later` and is not past evidence. Knowledge `evidence` is free text and is
  labelled as such - it is never resolved to a record or claimed to have existed at the cutoff.
- **Statuses and verifiability.** Both sources use the existing status vocabulary; a damaged memory
  store is named while the knowledge section still answers, and vice versa. The combined view is then
  not `complete` and not `verifiable`, and the operation remains `SUCCESS_VERIFIED` because it is a
  reproducible read - damage is disclosed, not converted into a missing or empty answer.
- **Bounds, persistence and authority.** Both sections share the AP-16 bound (20 default, 50
  maximum) and report `total`/`truncated`; knowledge conflict samples stay capped. The read writes
  no memory, knowledge or audit line of its own (the byte-for-byte guard covers memory and
  knowledge; the operation is audited by the ordinary lifecycle), calls no model, stays
  user-and-model readable and unplannable, and returns `authorizes:false`. The persisted audit copy
  is still minimized by the shared redaction, which masks every `content` value; verbatim memory
  content is available only from the store's own view.
- **Tests.** `memory-knowledge-history.test.js` (31 tests) drives the real stores, controller and CLI:
  memory before/after the cutoff, corrected once and twice across cutoffs, conflict before it,
  private exclusion, the absent retraction event; knowledge before/after, retraction and resolution
  after it, a resolution shown as a decision, a successor that does not retroactively supersede,
  free-text evidence, missing and later citations; a corrupt store on either side while the other
  answers; both stores in one certified snapshot; cross-process append and store change during the
  read; strict cutoff refusals, offset/date-only equivalence and the inclusive boundary; recorded
  time versus event time; determinism, bounds, read-only bytes, model-origin write denial,
  adversarial input, a later cutoff, and the CLI display and JSON listing. No model is contacted.

## 6. D. Diagnostics and evaluation

### Runtime diagnostics

- Schema: `schema`, `requestId`, `available`, `status`, `totalMs`, `measuredStages`, `stages`,
  `cognitive`, `executive`, `cancellation`, `failure`, `retries`, `clock`, `bounds`, `authorizes`.
- Sixteen fixed stage ids (`runtime-diagnostics.js`): request interpretation, evidence retrieval,
  claim extraction, contradiction detection, deliberation, grounded response, model call,
  model-output validation, proposal validation, handoff preparation, plan validation,
  authorization, execution, verification, task execution, finalization preparation.
- Stage outcomes: `ran`, `failed`, `skipped`, `unavailable`, `not_reached`. Durations are monotonic
  milliseconds or `null`; `null` is not zero. A clock fault keeps the outcome and nulls the
  duration. A skipped stage reports `null`, not `0`.
- Bounds: 20 stages, 10 count keys per stage, 60-character labels, 100-character request id, a
  day-clamped total, ~3.3 KB observed per answer.
- Privacy: no request, prompt, evidence text, model reply, action payload, or reasoning. Counts,
  ids, fixed labels, and timings only.
- Authority: `authorizes:false` always. Nothing in the lifecycle, registry, executor, verifier, plan
  store, or task store reads a diagnostics record to decide anything.
- Failure: if building the record throws, it becomes `available:false`, names
  `diagnostics_unavailable`, and the operation's status and audit line are untouched.

### Unified operational health (T-14)

`health.js` is a composition, not a new source of truth. `collectHealth(app, {checkModel,
modelTimeoutMs})` calls the reads each subsystem already exposes - `collectDiagnostics`,
`runtime.status()`, `situation.status()`, `integrations.status()`, `documents.status()`,
`reasoning.status()`, `worldModel.status()`, `learning.status()` - and derives a storage area
from the diagnostic store states. It writes no record, starts no runtime, polls no provider, and
holds no model handle.

- Ten areas: `application`, `model`, `runtime`, `situational`, `providers`, `documents`,
  `reasoning`, `world-model`, `learning`, `storage`. Every area carries `state`, `summary`, and
  the `source` read it came from.
- Five states with a fixed severity order: `healthy` (0) < `unknown` (1) < `degraded` (2) <
  `blocked` (3) < `failed` (4). The overall state is the worst non-advisory area, raised by any
  attention item. `unknown` ranks above `healthy` because an unreadable store or unperformed
  check is not a passing result, and below `degraded` because a known, explained degradation is
  more actionable.
- Evidence to state: diagnosis `OK`/`MISSING`/`NOT_CONFIGURED` map to `healthy` (absence of an
  uncreated store is valid), `CORRUPT`/`UNAVAILABLE` to `failed`, `UNCONFIRMED` to `degraded`,
  and `NOT_CHECKED` to `unknown`.
- Advisory model: without `--model` the model is not checked. Its area is reported but marked
  `advisory:true` and excluded from the overall, so a local install is not downgraded for a
  remote read nobody requested. `--model` adds a model-list probe and still runs no inference.
- Attention items: confirmed integrity findings and damaged areas are `failed`; suspicions,
  uncertain task steps, and non-live running tasks are `degraded` or `unknown`; approval waits,
  paused tasks, and recorded conflicts are `blocked`.
- Surfaces: CLI `health [--json] [--model]` prints the view and exits 0 only when the overall
  state is `healthy`; the authenticated loopback UI serves `GET /api/health` and renders a
  read-only panel with `textContent`. Both use the same composition.
- Claims: the view is an observation of readable records at one moment. It is not a monitor and
  not a score; it cannot see a live process whose records are stale, and a damaged checkpoint is
  quarantined by the store that reads it, never deleted. The renderer is bounded at 220 lines and
  40,000 characters, and no request, record, or secret text enters it beyond bounded summaries.
- Tests: `t14-health.test.js` (9 cases), `t14-workflows.test.js` (8), `t14-reliability.test.js`
  (2), `t14-scale-bounds.test.js` (1). See README "T-14 whole-system integration, reliability and
  operational validation" for the measured scale table and its limits.

### Cognitive evaluation

`cognition/evaluation.js` runs fixed synthetic scenarios in memory over the deterministic pipeline.
Nine dimensions (`request_interpretation`, `evidence_retrieval`, `contradiction_detection`,
`claim_grounding`, `clarification`, `abstention`, `response_consistency`, `proposal_validity`,
`lifecycle_correctness`) and four defect classes (`false_support`, `missed_contradiction`,
`unsupported_claim`, `inappropriate_proposal`). There is no composite score. The harness writes
nothing and does not call a model. It has no executive-handoff scenario; handoff has its own suites.

### Capability evaluation

`evaluation/capability.js` runs thirteen scenario classes through the real controller, registry,
stores and shipped read actions: single action, multi-step composition, missing-input
clarification, contradictory evidence, unsupported request, authorization denial, execution
failure, interrupted recovery, partial success, outcome verification, user correction,
repeated-request idempotency, and context continuity. Each scenario states what it expected and
what the records showed, and every step runs in its own temporary data directory. Six metrics
(`task_success`, `planning_correctness`, `evidence_correctness`, `safety_compliance`,
`recovery_correctness`, `usability`) are counted only over the scenarios that exercise them; an
unexercised metric is `null`, never a pass, and there is no composite score. One scenario uses a
loopback stub that speaks the model HTTP protocol so the denial path is exercised; no inference
is performed. The fixtures are synthetic, so the report is not a real-world intelligence
benchmark.

### Practical capability evaluation (Batch PC)

`tests/practical-eval.test.js` measures the practical capabilities added in Batch PC over the real
controller, stores and CLI entry points in temporary directories, with no model configured. Ten
dimensions are counted separately — capability coverage, supported completion, correct
clarification, unsupported refusal, authorization correctness, execution verification, recovery
correctness, outcome-reporting accuracy, feedback integrity, and multi-step workflow completion —
and a dimension reports its own checked/total counts, never a score, grade, or combined total. It is
a test file, not a second evaluation harness: there is no new module, store, registry or action, and
the only test double is an in-memory task-action fixture for the workflow cases. The fixtures are
synthetic; passing dimensions are evidence that the documented request, refusal, verification and
recovery paths behave as specified on those fixtures, not that any real-world outcome was achieved.

### Benchmark methodology and limits

- Deterministic fixtures written through the stores' own validated paths; no model, no network.
- Fresh temporary data directory per run; sequential runs; `--repeats`; medians reported.
- Controlled comparisons use a `git archive` copy of the prior commit and the working tree, run
  one after the other with nothing else running.
- Figures are single-machine observations, not targets or production claims. Cross-run differences
  can exceed the effect being measured; only in-run comparisons are treated as findings.

### Measured performance (see `README.md` for tables)

| Path | Historical | Current | Interpretation |
| --- | --- | --- | --- |
| Memory/knowledge search | AJ: 7.98 ms @20, 36.01 ms @200, 324.48 ms @800 records | Same order; linear in store size | The analysis is bounded at 36 evidence records; growth is the store search inside retrieval |
| Learning read before AM | ~3.5 s at the XL fixture | ~0.35 s after the per-snapshot index | Repeatable, same workload; equivalence tests pin the result |
| Answer request total | AO-08: 25.7/26.0/111.5/278.8/743.0 ms at 0/20/200/800/2,000 | Package H: 20.3/27.0/110.1/298.0/726.2 ms | Mixed sign, within run-to-run spread; no repeatable regression |
| Handoff build/check | — | ~0.06–0.12 ms (isolated) | Bounded record construction |
| Plan activation | — | 336–728 ms (fixture-dependent) | Dominated by store reads and task creation, not the handoff |
| Continuation | — | 9.8–10.6 ms (fixture); 220 ms `work`/`next` at XL | Reads the goal log once; the pre-AN shape replayed it per interrupted plan |
| Diagnostics overhead | — | 21.5–22.8 µs; record 3,334 bytes | Attached after the outcome is decided |
| Candidate comparison, AP-01 before → after | 0.14 / 0.26 / 0.85 ms at 4 / 10 / 20 candidates | 0.18 / 0.27 / 1.26 ms | The added counterfactual block costs about 0.04 / 0.01 / 0.41 ms (25% / 3% / 48%); warmed in-run medians over 15 samples; no cache or index added |
| Decision path, AP-01 vs prediction-informed (AP-02) | AP-01 0.201 / 0.262 / 0.687 ms at 4 / 10 / 20 candidates | AP-02 0.166 / 0.261 / 0.678 ms | Combined ledger + comparison, warmed in-run medians over 15 samples on identical fixtures; differences −0.035 / −0.001 / −0.009 ms, within run-to-run spread. Candidate bytes, gates and binding identical. The AP-02 currentness store read is not in this figure (see `benchmarks/README.md`) |
| Longitudinal analysis (AP-03, pure) | — | 0.21 / 0.40 / 2.74 / 2.73 ms at 20 / 100 / 500 / 1,000 evaluations | One capability, one group per 25 records capped at 20 groups; the 1,000-record read is bounded at 1,000 and discloses group truncation. In-run medians over 7 samples |
| Complete request, no-rule vs longitudinal (AP-03) | — | no rule 27.7 / 68.0 / 72.5 ms at 8 / 14 / 19 evaluations | AP-03 rule +1.2 / +5.8 / +7.1 ms (AP-02 +0.5 / +19.1 / +2.3 ms) over the identical store; includes the batched currentness read and machine noise. Partial (analysis/store/derivation) timings are printed separately and are not the request cost |
| Effectiveness read, complete request (AP-04) | — | 52.3 / 146.7 / 318.4 ms at 4 / 12 / 24 linked uses; 316.4 / 320.4 / 337.9 ms at 1 / 8 / 20 stored adaptations | Complete verified request (analysis + independent re-read + audit append) on synthetic histories where each use adds a plan and about ten audit records; about 13 / 12 / 13 ms per use. Pure analysis 27.5 / 71.4 / 167.6 ms and plan/audit reads are printed separately and are not the request cost. At 21 stored adaptations the oldest target falls outside the 20-record window, so its uses are not read (65.1 ms, disclosed) |
| Governance review path, complete request (AP-05) | — | list 166.3 / 474.2 / 996.0 ms; open 151.7 / 445.1 / 640.1 ms; inspect 338.7 / 667.0 / 1,231.2 ms; reconcile 240.9 / 632.5 / 1,160.7 ms; decide 163.9 / 345.8 / 608.5 ms at 4 / 12 / 24 linked uses; list 967.8 / 997.4 / 1,049.9 ms at 1 / 8 / 20 stored adaptations | Complete verified request including its own analysis, evidence assembly and audit append; builder/detail/prepare reads are printed separately and labelled partial. At 21 stored adaptations the target is outside the 20-row window and is not reported (82.1 ms, disclosed; less lineage work, not faster execution). Five samples per figure |
| Cross-store reads, complete request (AP-06) | — | integrity 20.9 / 23.6 / 33.5 ms; effectiveness 31.5 / 39.4 / 57.5 ms; reviews 34.9 / 41.0 / 56.9 ms at 100 / 1,000 / 4,000 memory records (9 stores, 146 / 1,046 / 4,046 records) | Complete verified requests including their own window(s), second read and audit append on identical copied bytes. The window alone took 1.07 / 0.72 / 0.78 ms and the integrity report alone 10.0 / 11.4 / 14.8 ms; those partials are printed separately and not added. The same effectiveness analysis with and without a window moved by −0.1 / +0.6 / +1.0 ms, so window cost is per store, not per record; growth is parsing and lineage. Five samples per figure |
| Evidence consistency, complete requests (AP-07) | — | integrity 21.7 / 25.9 / 133.1 ms; candidates 22.7 / 64.1 / 70.1 ms; longitudinal 10.0 / 26.8 / 30.0 ms; outcome 33.7 / 128.0 / 154.6 ms; effectiveness 35.7 / 150.1 / 158.9 ms; reviews 33.6 / 150.8 / 122.5 ms at 100 / 1,000 / 4,000 memory records | Complete verified requests including their own content windows and audit appends. On the same run the window over the seeded retrieval control cost +1.8 / +2.8 / +15.4 ms, matching the standalone content window (+1.0 / +1.6 / +11.0 ms over metadata); world-state certification cost +2.9 / +9.7 / +16.0 ms. Complete-read spreads are wide and cross-run variation exceeds several differences; only in-run comparisons are treated as findings. See `benchmarks/README.md` |
| Historical memory and knowledge listing (AP-18) | — | memory replay 13.0 / 34.2 / 89.1 ms; knowledge replay 14.8 / 45.1 / 170.6 ms; both 27.8 / 79.3 / 259.7 ms; complete verified `history.reconstruct` 151.8 / 221.0 / 493.6 ms at 200 / 1,000 / 4,000 records per store (1,000 audit lines) | Medians of five samples in one run on generated fixtures with no overlapping runs. Output bounds barely move runtime (limit 2 vs 50: 483.5 vs 488.2 ms at 4,000, 2,824 vs 16,951 display bytes); a cutoff including the whole log costs more (607.2 ms end-to-end at 4,000) because both derivations are full-size. Resolving 200 citing rows added about 3%. Verification re-runs the reconstruction at about 1.36x execute-only (361.7 vs 493.6 ms). Full-log replay is accepted; no index was added |
| Offline deterministic answer (no model) | — | deterministic answer 34.5 / 99.6 / 106.1 ms; no-evidence fallback 29.5 / 103.4 / 111.6 ms at 20 / 200 / 1,000 memory records | Medians of five samples in one run, no overlapping runs, through the real controller with no backend. The answer/fallback in-run ratio is 1.17 / 0.96 / 0.95, so the cited rendering and response contract add no measurable cost over the fallback that shares the same model-free analysis; growth is the store search inside retrieval (about 3.08x from 20 to 1,000 records), matching the existing retrieval scaling. This measures the new path's internal cost, not a before/after: the offline path now runs the analysis it previously skipped, which is the work that produces the answer. The first sample is cold (store/index warm-up) and the median excludes it |

Known scaling behavior: memory and knowledge searches are linear in the number of records; JSONL
cold reads parse the whole store; the AM index removes the repeated learning read, not the initial
one; and every cutoff reconstruction replays the whole source log, so its output is bounded while
its cost is not. No quadratic path is claimed or known in the request path. Unmeasured: real-model
latency and quality, stores beyond the fixtures used, multi-user or network filesystems, and
long-running operation logs.

## 7. Authority and trust-boundary map

The only authority owner is the action registry. Everything else observes, proposes, or records.

| Statement | Where it is enforced | Where it is tested |
| --- | --- | --- |
| Model output does not authorize actions | `controller/proposals.js` (typed `action`/`input`, `authority:'none'`), `actions/registry.js` (model-origin writes unregistrable), `actions/origins.js` | `model-self-authorization.test.js`, `proposal-boundary-an.test.js` |
| Claims do not prove execution | `cognition/response.js` (action-claim correction), `cognition/trace.js`, `executive/handoff.js` (outcomes only from step records) | `cognition-scenarios.test.js` G/J/O, `execution` tests |
| Proposals do not constitute approval | `proposals/model.js` (decision is a separate event), `plans/model.js` (approval is a user event) | `executive-adversarial.test.js` J-01–J-11, `acceptance-ao09.test.js` 1 |
| Approval does not bypass authorization | `plans/validity.js` + activation path; registry re-decides each step | `executive-acceptance.test.js` K-05, `plan-adversarial.test.js` |
| Execution does not establish verification | `verify/verifier.js` (separate component), status rule in `controller.js` | `executive-bridge.test.js`, `executive-acceptance.test.js` K-13–K-16 |
| Verification does not establish real-world truth | Verifier checks a postcondition; the outcome vocabulary distinguishes verified/uncertain/unavailable | `outcomes.js` consumers, `failure-semantics.test.js` |
| Diagnostics never grant authority | `runtime-diagnostics.js` (`authorizes:false`); nothing reads it to decide | `runtime-diagnostics-ao.test.js` |
| Missing records do not establish success | Continuation/recovery read states; a missing step record is unknown/unrecordable, not success | `plan-continuation.test.js`, `executive-interruption.test.js` |
| A handoff never grants authority | `executive/handoff.js` (`authorizes:false` on every record) | `handoff-integrity-ao.test.js`, `handoff-hash-binding-ao.test.js` |
| A retracted/superseded record stops supporting a claim | `cognition/lineage.js` (`reassessClaims`), late re-check in `controller.js` | `cognition-lineage.test.js`, `acceptance-ao09.test.js` 4-5 |
| An approved adaptation does not gate, approve, or execute | `plans/evaluation.js` computes the decision after every gate; `plans/guidance.js` says `authorizes:false`; `plans/validity.js` and the registry are unchanged | `adaptation-decision.test.js` (bounded influence), `plan-guidance.test.js` |
| An influenced comparison cannot record candidate bytes it did not read | `executive/selection.js` refuses `candidate-changed` against the comparison's bound digests | `adaptation-decision.test.js`, `plan-guidance.test.js` |
| A prediction verdict, model suggestion, or unapproved rule moves no decision | The guidance ledger admits only user-approved, active, evidence-backed, shaped records; everything else is inert | `adaptation-decision.test.js` (eligibility), `adversarial-batch-am.test.js` I-01–I-08 |
| A prediction-derived candidate cannot gain authority from its own evaluation | `experience/prediction-derivation.js` is pure and returns only a typed proposal; `adaptation.derive` appends an unapproved candidate; `adaptation.decide` is the only approval and remains user-origin only; the registry and plan-validity paths are unchanged | `prediction-adaptation-learning.test.js` (approval separation, authority isolation), `prediction-adaptation-boundary.test.js` |
| A stale prediction lineage cannot leave approved guidance active | `experience-store.js` `#predictionCurrentness` re-reads the cited predictions (`predictions.details`, one batched ledger read per check) and forces `active:false` | `prediction-adaptation-learning.test.js` (stale/unreadable ledger), `prediction-adaptation-boundary.test.js` |

### Known gaps between documentation and code

1. The ten-stage contract is a **reading and a consistency check**, not an enforcement point; the
   registry and plan validity enforce. The contract itself says so.
2. Contract stage 10 (`learning_and_outcome`) is recorded `not_reached` on every request today,
   because the contract is built before finalization writes the audit line. This is accurate, not
   a bug; a later batch could build it after finalization if it wants a two-record view.
3. Two interruption boundaries — "after approval, before activation" and "inside authorization" —
   have no real killed child. Their refusal behavior is tested in-process; no persisted intermediate
   state exists to kill at those instants. See `README.md` Batch AO package H.
4. Diagnostics validate behavior, not semantic truth. No diagnostic field records whether a claim is
   true.
5. The `world` command is a projection; the World Model is the separate append-only
   `world-model.jsonl`. Neither projection nor model output can write it.
6. Remote synchronization is unverified: `git fetch origin` fails with "Repository not found" on
   this machine, so `origin/main` is only as reliable as the last successful fetch.
7. `stark/` is separate research; `apex_app/` does not import it. A versioned neural proposal
   contract exists in `src/neural/` and is declared by `neural.contract`, but no runtime is
   connected: no process or HTTP transport, no model, and no bridge that lets a proposal reach a
   store or an action without an existing user-origin gate.

## 8. Consolidated capability matrix (Batch AO)

| Capability | Status | Implementation | Test evidence |
| --- | --- | --- | --- |
| Executable cognitive lifecycle | `IMPLEMENTED_AND_TESTED` | `cognition/lifecycle.js`, `contract.js` | `cognition-lifecycle.test.js`, `cognition-contract.test.js` |
| Typed cognitive artifacts | `IMPLEMENTED_AND_TESTED` | `cognition/artifacts.js` | `cognition-artifacts.test.js` |
| Cancellation and request identity | `IMPLEMENTED_AND_TESTED` | `lifecycle.js`, `controller.js`, `session.js` | `cognition-lifecycle.test.js` (real child) |
| Duplicate request handling | `IMPLEMENTED_AND_TESTED` | `controller.js`, `proposals/store.js` | `integration-runtime-an.test.js`, `handoff-integrity-ao.test.js` B1/B4 |
| Proposal lifecycle (pending/accepted/rejected/invalidated/expired/stale/invalid) | `IMPLEMENTED_AND_TESTED` | `proposals/model.js`, `proposals/store.js` | `executive-continuation.test.js`, `acceptance-ao09.test.js` 1-2 |
| Evidence lineage and claim re-evaluation | `IMPLEMENTED_AND_TESTED` | `cognition/lineage.js` | `cognition-lineage.test.js` |
| Late evidence re-checking | `IMPLEMENTED_AND_TESTED` | `cognition/evidence.js`, `controller.js` | `acceptance-ao09.test.js` 4-5 |
| Claim validity and evidence states | `IMPLEMENTED_AND_TESTED` | `cognition/vocabulary.js`, `claims.js`, `response.js` | `cognition-evidence-states.test.js`, `cognition-scenarios.test.js` |
| Deterministic cognitive evaluation | `IMPLEMENTED_AND_TESTED` | `cognition/evaluation.js` | `cognition-evaluation.test.js`, `acceptance-ao09.test.js` 6 |
| Executive handoff | `IMPLEMENTED_AND_TESTED` | `executive/handoff.js`, `mapping.js` | `handoff-integrity-ao.test.js`, `executive-bridge.test.js` |
| Approval and hash binding | `IMPLEMENTED_AND_TESTED` | `plans/model.js`, `executive/preview.js` | `handoff-hash-binding-ao.test.js`, `executive-acceptance.test.js` K-04/K-22 |
| Authorization | `IMPLEMENTED_AND_TESTED` | `actions/registry.js`, `origins.js` | `model-self-authorization.test.js`, `capability-inventory.test.js` |
| Execution verification | `IMPLEMENTED_AND_TESTED` | `verify/verifier.js`, `controller.js` | `executive-bridge.test.js`, `executive-acceptance.test.js` |
| Cross-process continuation | `IMPLEMENTED_AND_TESTED` | `plans/continuation.js`, `continuation/engine.js` | `plan-continuation.test.js` (real children), `continuation-cross-process-an.test.js` |
| Runtime diagnostics | `IMPLEMENTED_AND_TESTED` | `cognition/runtime-diagnostics.js` | `runtime-diagnostics-ao.test.js` |
| Performance optimization (learning read) | `IMPLEMENTED_AND_TESTED` | AM per-snapshot index in the learning read path | `learning-read-equivalence.test.js`, `plan-dimensions.test.js` |
| Evidence-driven decision adaptation (AP-01) | `IMPLEMENTED_AND_TESTED` | `plans/evaluation.js` (`adaptationDecisionOf`), `plans/guidance.js`, `executive/selection.js` | `adaptation-decision.test.js` (23 cases), `plan-guidance.test.js`, `plan-scenarios-am.test.js` |
| Prediction-derived adaptation (AP-02) | `IMPLEMENTED_AND_TESTED` | `experience/prediction-derivation.js`, prediction branch in `experience/experience-store.js`, `adaptation.eligibility` in `actions/experience-actions.js`, `plans/evaluation.js` disclosure | `prediction-adaptation-learning.test.js` (21 cases), `adaptation-decision.test.js`, `prediction-adaptation-boundary.test.js` |
| Longitudinal outcome analysis (AP-03) | `IMPLEMENTED_AND_TESTED` | `prediction/longitudinal.js`, `adaptation.derive` longitudinal branch in `experience/experience-store.js`, `longitudinal`/`derivation` classification in `actions/experience-actions.js`, `predictions.details` batch read in `prediction/prediction-store.js`, `sources.longitudinalDerived` in `plans/guidance.js`/`evaluation.js` | `longitudinal-outcome-analysis.test.js` (29 cases), `prediction-adaptation-learning.test.js`, `adaptation-decision.test.js` |
| Adaptation effectiveness and outcome tracing (AP-04) | `IMPLEMENTED_AND_TESTED` | `plans/effectiveness.js` (pure read), `adaptation.effectiveness` in `actions/experience-actions.js`, controller/CLI read surface; uses only the existing experience, plan, audit and goal stores | `adaptation-effectiveness.test.js` (20 cases) |
| Adaptation governance and evidence reconciliation (AP-05) | `IMPLEMENTED_AND_TESTED` | `experience/review.js` (canonical evidence and reconciliation), `plans/governance.js` (pure reads), review record kinds in `experience/experience-store.js`, five `adaptation.review*` actions in `actions/experience-actions.js`, controller/CLI surface; no new store or authority | `adaptation-governance.test.js` (41 cases) |
| Content-certified window and bounded-read contract (AP-07) | `IMPLEMENTED_AND_TESTED` | content identity in `evidence/snapshot.js`; nine-state `evidence/read-contract.js` | `evidence-read-contract.test.js` (14 cases), `evidence-fabric.test.js`, `ap07-consistency.test.js` |
| Consumer-wide evidence consistency (AP-07) | `IMPLEMENTED_AND_TESTED` | cognitive retrieval, world state, prediction longitudinal, plan candidate/outcome/assessment and the existing effectiveness/governance reads through one content window | `ap07-consistency.test.js` (31 cases), existing consumer suites |
| Response contract and model-output trust boundary (AP-08) | `IMPLEMENTED_AND_TESTED` | `cognition/response-integrity.js`: fourteen-stage contract with runtime statuses, five-state trust ladder capped below `verified`, bounded prose-free audits | `cognition-response-integrity.test.js` (42 cases) |
| Claim-level grounding and safe degradation (AP-08) | `IMPLEMENTED_AND_TESTED` | `cognition/response-integrity.js`: per-claim evidence state and lexical attribution, closed limitation codes, deterministic `no_output`/`present_as_is`/`present_with_limitations` | `cognition-response-integrity.test.js` (42 cases), existing `cognition-evidence-states.test.js` |
| Semantic claim assessment (AP-09) | `IMPLEMENTED_AND_TESTED` | `cognition/semantic-consistency.js`: closed thirteen-outcome vocabulary with fixed precedence, eight bounded dimensions, fixed reason labels, `authorizes:false` | `semantic-consistency.test.js` (88 cases, 28 attack classes), `semantic-acceptance.test.js` |
| Response-level claim consistency (AP-09) | `IMPLEMENTED_AND_TESTED` | `cognition/semantic-consistency.js` (`assessResponseConsistency`): 12 claims, 6 factual pairs, contradiction index pairs, `overstated` | `semantic-consistency.test.js`, `semantic-acceptance.test.js` |
| Semantic gating of model-output trust (AP-09) | `IMPLEMENTED_AND_TESTED` | `cognition/response-integrity.js`: `factually_supported` requires semantic consistency, `semantic_*` limitations, prose-free semantic audit block, controller notice | `semantic-acceptance.test.js` (18 cases), `cognition-response-integrity.test.js` |
| Adversarial acceptance | `IMPLEMENTED_AND_TESTED` | Cross-cutting; no new runtime component | `acceptance-ao09.test.js` (7), `adversarial-batch-am.test.js` (16), `plan-adversarial.test.js` (15), `executive-adversarial.test.js` (11), plus the suites cited in `README.md` Batch AO package H |
| Cross-process interruption | `IMPLEMENTED_PARTIALLY_TESTED` | Real child fixtures at most boundaries | `plan-continuation.test.js`, `continuation-cross-process-an.test.js`, `finalization-interruption.test.js`, `process-recovery.test.js`, `cross-process-ao09.test.js`; two boundaries lack a killed child |
| Concurrent store integrity | `IMPLEMENTED_AND_TESTED` | `memory/writer-lock.js`, store locks, JSONL append | `storage-concurrency.test.js`, `store-write-concurrency.test.js`, `cross-process-stress.test.js`, `lock-contention.test.js`, `lock-recovery.test.js` |
| World Model (append-only records, read-time reduction) | `IMPLEMENTED_AND_TESTED` | `world/store.js`, `world/model.js`, `world/query.js` | `world-model-core.test.js`, `world-model-scenarios.test.js` |
| Prediction ledger | `IMPLEMENTED_AND_TESTED` | `prediction/*`, `actions/prediction-actions.js` | `prediction-*.test.js` (6 suites) |
| Expectation caution on the continuation recommendation (AP-13) | `IMPLEMENTED_AND_TESTED` | `prediction/caution.js`, `PredictionStore.expectationCautions`, `continuation/engine.js`, `executive/readiness.js`, controller wiring | `expectation-caution.test.js` (38 cases) |
| Cross-store belief trace and retrieval contradiction link (AP-14) | `IMPLEMENTED_AND_TESTED` | reverse citation index in `world/query.js`, pure `world/belief-trace.js`, `MemoryStore.traceMany`, `world.belief.trace` action and CLI, `linkCrossStoreCitations` in `cognition/evidence.js` | `belief-trace.test.js` (18 cases) |
| Historical belief reconstruction (AP-15) | `IMPLEMENTED_AND_TESTED` | pure `world/historical.js` (`validityStanding`, `statementStanding`, `reconstructBelief`, `relevantChanges`), `WorldModelStore.historicalView`, as-of `MemoryStore.traceMany` and `KnowledgeStore.getMany`, `world.belief.trace --at` and `world.state_at` belief output, strict `parseIsoInstant`; no store, schema field or index added | `temporal-belief.test.js` (18 cases, including real CLI child processes) |
| Cross-store cognitive history (AP-16) | `IMPLEMENTED_AND_TESTED` | `src/history/reconstruct.js` (one `runConsistentEvidenceRead` across experience, prediction and world replays; per-source status, later separation, citation resolution, bounds, `authorizes:false`), `history.reconstruct` action (read, user+model, unplannable), `history --at` CLI; no store, schema field or index added; the goal, plan, task and operations stores were disclosed as unsupported by AP-16 and are integrated by AP-17; memory and knowledge remain disclosed as unsupported | `history-reconstruction.test.js` (18 cases, including real CLI child processes) |
| Historical executive state (AP-17) | `IMPLEMENTED_AND_TESTED` | `src/history/executive.js` (goal, plan, task and audit rows; `later` flags; `CUTOFF_SEMANTICS`; `EXECUTIVE_LIMITATIONS`), `historicalView(cutoff)` on the goal, plan and task stores, executive sections and operation citations in `src/history/reconstruct.js`, rendering in `src/actions/history-actions.js`; same action, no new action/store/index; audit rows classified because the log has no recorded-at; `approval.usable` always false | `executive-history.test.js` (34 cases, including a real CLI child process) |
| Historical memory and knowledge reconstruction (AP-18) | `IMPLEMENTED_AND_TESTED` | `src/history/memory-knowledge.js` (`memorySection`, `knowledgeSection`, `MEMORY_KNOWLEDGE_CUTOFF_SEMANTICS`, `MEMORY_KNOWLEDGE_LIMITATIONS`), the stores' existing `historicalView(cutoff)` reads inside the same certified window, memory/knowledge sections and merged limitations in `src/history/reconstruct.js`, rendering in `src/actions/history-actions.js`; same action, no new action/store/index; private memory excluded by count; free-text knowledge evidence never treated as a citation | `memory-knowledge-history.test.js` (31 cases, including real CLI child processes) |
| Offline deterministic answering | `IMPLEMENTED_AND_TESTED` | `cognition/response.js` (`buildDeterministicAnswer`), `controller/controller.js` (`#offlineAnswer`, the no-backend branch of `answerWithModel`), `outcomes.js` (`success_deterministic`), `cli.js` (exit 0 and a note). The model-free analysis already ran for every request, so this adds no store, action, or model call; only prompt-eligible memory/knowledge claims are rendered, cited and bounded, and the audited output is content-free. A contradiction is disclosed with both sides, an ambiguity is clarified before any prompt, and an unsupported question still reports `model_unavailable` | `offline-answer.test.js` (13 cases, real controller/stores/CLI child processes) |
| Task-to-plan outcome sync on run/resume/retry | `IMPLEMENTED_AND_TESTED` | `controller/controller.js` (`#syncPlanFromTask`, called from `runTask` after the handoff) and `plans/model.js` (`reconcilableOutcomes`, the reducer's own rule stated once). A sync reads the plan before writing and records only outcomes it does not already hold: the same status again is a no-op, an uncertain result may be replaced by a later reading, and a failed result may be replaced only by a non-completed one, because completing a step that failed earlier needs a new plan revision. Status changes follow only the reducer's table, and a blocked plan is reopened only when every step holds a completed verified outcome. Never completes a goal and never executes; a plan-write problem is a display note, not a rewrite of the task's own verified result | `task-plan-sync.test.js` (2 cases) and `task-plan-reconciliation.test.js` (8 cases: partial recorded outcomes, uncertain recovery, failed step stays failed, repeated sync idempotent, standalone task, plan-write failure disclosed, real cross-process interruption) |
| Personal workspace assistance (Batch PC) | `IMPLEMENTED_AND_TESTED` | `filesystem/workspace.js` (`filesystem.find`, `summarize`, `compare`, `report`, `write`), registered beside the existing `filesystem.list`/`read` only when `APEX_FILESYSTEM_ROOT` is set. Every action is user-origin only and every path is re-resolved inside the root at execution time; reads are independently re-checked, and the write is create-only unless its current SHA-256 is supplied, atomic, and not `plannable`. No new store, registry, authorization rule or model call | `workspace.test.js`, `practical-eval.test.js` (real CLI create/read/compare/summarize/report, refused unguarded overwrite, verified guarded replacement, audit payload omitted) |
| Structured personal notes (usable-offline R-01) | `IMPLEMENTED_AND_TESTED` | `notes/note-store.js` (append-only `notes.jsonl`: revision chain, compare-and-swap against the named head, cited sources that are references and not agreement, private sensitivity, per-note history), `actions/note-actions.js` (`note.add`, `note.update`, `note.from_digest` write; `note.list`, `note.show`, `note.search`, `note.history` read), controller and CLI `note` commands, NL routes. Every action is user-origin and unplannable; a private body stays out of list bodies, search, an unqualified show, and the audit result data; no note text is copied into `operations.jsonl`, and nothing derives a fact, adaptation, or plan from a note | `notes.test.js` (13 cases: revisions and readable history, stale revision refused, private exclusion, model-origin and credential refusal, audit body omission, digest citations, NL routes, damaged-log refusal, CLI) |
| Workspace lifecycle and named roots (usable-offline R-02) | `IMPLEMENTED_AND_TESTED` | `filesystem/lifecycle.js` (`filesystem.mkdir`, `move`, `delete`, `restore`, `trash`, `batch`), `filesystem/roots.js` (`APEX_WORKSPACES`, an immutable frozen set whose names select a root and never authorize beyond it), `filesystem/path.js` (`validateRoot` label), controller `/workspace` command methods and CLI `workspace` commands; NL routes for mkdir/move/delete/trash/restore. Delete writes a manifest and renames into `.apex-trash/<uuid>/`, so it is reversible; restore refuses an occupied path and removes the quarantine item only after the rename; batch preflights every operation against the starting state, refuses conflicts and intra-batch parent dependencies, and reports partial completion honestly. Every action is user-origin, unplannable, and independently verified; no new store and no model call | `workspace-lifecycle.test.js` (28 cases: mkdir, move, quarantine delete/restore, batch preflight and conflicts, six-boundary containment, named roots and `APEX_WORKSPACES` parsing, NL and CLI routes) |
| Document text extraction (usable-offline R-03) | `IMPLEMENTED_AND_TESTED` | `filesystem/documents.js` (bounded ZIP central-directory reader with CRC32 and `inflateRaw`; DOCX `word/document.xml`; XLSX shared strings plus the first worksheet; PDF `FlateDecode` streams read through `Tj`/`TJ`; RFC4180-style CSV with one chosen delimiter; UTF-8 text), the `filesystem.extract` read action in `filesystem/workspace.js`, the same extraction behind `filesystem.summarize`, controller `workspaceExtract`, CLI `workspace extract`, and the NL route `extract text from <path>`. Bounds: 4 MB input, 200,000 extracted characters, 512 ZIP entries, 8 MB per entry and 24 MB total, 500 decoded PDF streams with 2,000 examined markers, 2,000 CSV/XLSX rows and 50 columns. A damaged, encrypted, unsupported or over-complex document raises a named error rather than a partial answer; embedded content is never executed, no model is consulted, and the audit record keeps counts, a text hash and the stated limitations rather than the text. User-origin only; plannable for a user plan and never offered to a model plan | `document-extraction.test.js` (24 cases with real PDF, DOCX, XLSX and CSV fixtures, verification, bounds, damaged and encrypted files, model-origin denial, NL and CLI) |
| Recorded deadline ingestion (usable-offline R-04) | `IMPLEMENTED_AND_TESTED` | `deadlines/store.js` (append-only `deadlines.jsonl`: strict calendar or UTC date, title, source path, source SHA-256 and line, user-supplied provenance, identity dedupe), `actions/deadline-actions.js` (`deadline.import`, a user-origin, unplannable write that reads one bounded JSONL/NDJSON/CSV/TSV file inside a named workspace root and refuses the whole file on any malformed line; `deadline.list`, a plannable read of the ledger within a horizon), controller `deadlineImport`/`deadlineList`, CLI `deadline list|import`, and NL routes. `work/review.js` takes the ledger as an optional fourth source: it discloses each recorded date with its source file and line, counts what falls inside the horizon, and adds deadline attention items derived only from the recorded date. No date is inferred, nothing is scheduled, and a date passing changes nothing | `deadlines.test.js`, `work-review.test.js` |
| Versioned backup and confirmed restore (usable-offline R-05) | `IMPLEMENTED_AND_TESTED` | `backup/archive.js` (one JSON archive with a manifest of the fixed fifteen-file APEX data contract, each file's byte length and SHA-256, and a recomputed manifest digest; export re-stats every file to refuse a read that overlapped a writer; bounds of 32 MiB per file, 48 MiB total and 64 MiB per archive; `inspectArchive` validates structure, versions, paths, lengths and digests before anything is written; `restoreArchive` requires at least eight characters of the archive digest as confirmation, refuses while a store lock file exists, refuses to replace existing bytes without `replaceExisting`, writes a pre-restore archive under `backups/` before replacing anything, stages every file and renames it into place, re-reads each digest, and leaves files the archive does not hold in place; a file the directory does not hold is created rather than replaced, since there is nothing to overwrite or preserve, so it needs neither `replaceExisting` nor a pre-restore copy, and the result reports `created`, `replaced` and `unchanged` separately). `actions/backup-actions.js` registers `backup.export`, `backup.inspect` and `backup.restore` as user-origin, unplannable actions; controller `backupExport`/`backupInspect`/`backupRestore`; CLI `backup export|inspect|restore --confirm [--replace-existing]`. The inspect action's operation record carries the manifest (name, bytes, digest, line counts), never the stored text of the files it read. The archive is not signed or encrypted, the restore's own audit line is appended to the restored log after the replacement, and the pre-restore archive is the record of what was there before | `backup.test.js` (24 cases: export bounds and stability, tampered/duplicate/unknown entries refused before any write, confirmation and `replaceExisting` refusal, creation-only restore into an empty directory, pre-restore archive, lock refusal, files left in place, the inspection record carrying no store text, model-origin denial, unplannability and audit fields, real CLI round trip) |
| Usable offline release acceptance and scale envelope (usable-offline R-06) | `IMPLEMENTED_AND_TESTED` | No runtime component. `tests/offline-release.test.js` drives one owner's workflow across the release capabilities through the assembled controller, stores, and CLI, reads the evidence back from a second process, and recovers from a corrupt or deleted store. `tests/release-scale.test.js` exports, inspects, and restores a multi-megabyte store set with exact digests and checks the per-file and total export bounds. `benchmarks/run-release-benchmark.mjs` measures the release paths through the real controller with `NoBackend`; its first run found that `backup.inspect` copied every archive file's text into its operation record, which the action now omits | `offline-release.test.js` (4 tests), `release-scale.test.js` (3 tests), `backup.test.js` (the inspection-record assertion); the benchmark is not part of `npm test` |
| Cross-source knowledge digest (Batch PC) | `IMPLEMENTED_AND_TESTED` | `knowledge/digest.js` (`buildKnowledgeDigest`, `renderDigest`), `knowledge.digest` read action in `actions/knowledge-actions.js` with an independent two-store re-read, and the `knowledge digest` CLI. Reads memory and knowledge separately, with each store's counts, health, current records and stored correction/supersession/retraction/conflict links; never merges, ranks or links the two sources, and excludes private memory from a model-origin read | `knowledge-digest.test.js`, `practical-eval.test.js` |
| Recorded work portfolio review (Batch PC) | `IMPLEMENTED_AND_TESTED` | `work/review.js` (`buildWorkReview`, `renderWorkReview`), `work.review` read action in `actions/work-actions.js` with a three-store verifier, and the `review` CLI. Reports open goals, plans and tasks with stored status, recorded deadlines, blockers and step counts, plus a closed-vocabulary, severity-ordered attention list; ranks nothing, decides nothing, and reports an unreadable store as unavailable rather than empty | `work-review.test.js`, `practical-eval.test.js` |
| User-confirmed task outcome feedback (Batch PC) | `IMPLEMENTED_AND_TESTED` | `actions/task-feedback-actions.js` (`task.feedback`), user-origin only and `plannable:false`, plus the `task feedback` CLI. Refuses unless the task and every step are completed, every step has an audit record, and a recorded run ended `success_verified` with the task completed; records your assessment against that run with user provenance and derives or applies no rule | `task-feedback.test.js`, `practical-eval.test.js` (model-origin write denied) |
| Practical capability evaluation (Batch PC) | `IMPLEMENTED_AND_TESTED` | `tests/practical-eval.test.js` only; no runtime component. Ten dimensions measured separately through the real controller, stores and CLI in temporary directories; no combined score and no model | `practical-eval.test.js` (13 tests, 10 suites) |
| Local browser interface (Batch T-06) | `IMPLEMENTED_AND_TESTED` | `ui/server.js` (loopback-only HTTP server started by `bin/apex-serve.js`: process-random token in the printed URL exchanged for an `HttpOnly; SameSite=Strict` cookie, Bearer or cookie auth, `x-apex-ui: 1` header plus same-origin `Origin` plus JSON content type on every POST, CSP with `default-src 'none'` and no remote origin, 64 KiB body cap, 4000-character messages, one chat in flight, eight SSE subscribers, 1 MiB buffered-write cap, 120 s chat timeout), `ui/assets.js` (page, stylesheet and client script built with `textContent` only). Chat, task run/resume/retry/cancel and plan approval call the same controller methods the CLI calls, so the page adds no action, store, or authorization path; the conversation view reads `ConversationStore.transcript`, which includes turns the model path never replays. Loopback addresses only (`127.0.0.1`/`::1`); it is not a hosted or multi-user service | `ui-server.test.js` (15 real HTTP tests, including a real `bin/apex-serve.js` child process: auth refusal, cross-origin and wrong-content-type refusal, body and message bounds, SSE subscriber cap, task visibility, approval surface, session continuity) |
| Unified operational health (T-14) | `IMPLEMENTED_AND_TESTED` | `health.js` (composition of existing subsystem reads; ten areas; five states with fixed severity; advisory unprobed model; bounded renderer), CLI `health [--json] [--model]`, authenticated UI `GET /api/health` and read-only panel; writes no store and authorizes nothing | `t14-health.test.js` (9 cases) |
| Whole-system integration acceptance (T-14) | `IMPLEMENTED_AND_TESTED` | No runtime component. `tests/t14-workflows.test.js` (8 cases, workflows A-G through the real controller, stores, runtime and spawned CLI children), `tests/t14-reliability.test.js` (2 cases: restart durability with no replay, torn final record read as damage), `tests/t14-scale-bounds.test.js` (1 case: the repaired 500-document ingest boundary), `benchmarks/run-t14-scale-benchmark.mjs` (outside `npm test`, `NoBackend`, isolated temp dirs, 51 checks) | those suites and benchmark |
| Temporal experience | `IMPLEMENTED_AND_TESTED` | `experience/temporal.js`, `experience-store.js` | `experience-temporal*.test.js` |
| Model gateway protocol (stub) | `IMPLEMENTED_AND_TESTED` | `model/gateway.js` | `gateway.test.js`, `model-workflow.test.js`; no test runs a real model |
| Real-model answer quality | `DESCRIPTIVE_ONLY` | — | One dated observation (2026-10-31); no automated evidence |
| Neural integration | `CONTRACT_ONLY` | `neural/contract.js`, `neural/runtime.js`, `neural/lifecycle.js`, `neural/diagnostics.js`; declared by `neural.contract` | `neural-boundary.test.js`; no runtime connected, no process or HTTP transport, no model, no `stark/` import |
| General planner, persistent learning, voice | `NOT_IMPLEMENTED` | — | Scope statements only |
| Evaluation of executive handoff | `DEFERRED` | Handoff has its own suites | Deliberately not added to `cognition/evaluation.js` |

## 9. Acceptance and risk register

Carried forward from AO-09 and re-checked against the code. "Blocks next milestone" means it would
invalidate the recommended milestone, not that it blocks all work.

| # | Item | Existing implementation | Test evidence | Remaining gap | Severity | Blocks next milestone |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Process termination during authorization | Registry decides in memory; no persisted intermediate state | `model-self-authorization.test.js`, `proposal-boundary-an.test.js` | No real child killed inside the registry call | Low | No |
| 2 | Process termination during verification | Finalization/continuation children stop before/after verification | `finalization-interruption.test.js`, `plan-continuation.test.js` | Exact instant between action and verification is covered as `uncertain`, not as a killed child | Low | No |
| 3 | Direct TaskRunner bypass testing | TaskRunner is invoked only through the controller's action path; no shell/code execution | `acceptance-ao09.test.js` 7, `executive-bridge.test.js` | In-process code could import the runner directly; that is outside the model threat model | Low | No |
| 4 | Expired proposal replay | `proposals/store.js` refuses a decision on an expired proposal | `acceptance-ao09.test.js` 2 | None observed | None | No |
| 5 | Superseded proposal replay | No `superseded` state; invalidation is the recorded mechanism | `acceptance-ao09.test.js` 1 | Naming difference only; no bypass observed | Low | No |
| 6 | Denied/rejected proposal replay | Decision is irrevocable; replay is refused | `acceptance-ao09.test.js` 1, `executive-adversarial.test.js` | None observed | None | No |
| 7 | Concurrent approval and activation | Activation re-reads the live plan under the lock and rechecks version/hash | `plan-continuation.test.js`, `executive-reliability.test.js` | No dedicated two-process approval/activation race | Low | No |
| 8 | Concurrent cancellation and continuation | Cancellation is request-scoped; continuation takes the task lock | `cognition-lifecycle.test.js`, `plan-continuation.test.js` | No dedicated cancellation-vs-continuation child race | Low | No |
| 9 | Persisted diagnostics corruption | Diagnostics is a field on the audit line; damaged audit handling is fail-closed | `store-health.test.js`, `corruption-recovery-boundaries.test.js` | No test corrupts only the diagnostics field and asserts how it is reported | Low | No |
| 10 | Diagnostics failure during a real controller operation | Build failure yields `available:false`; operation untouched | `runtime-diagnostics-ao.test.js` | Covered in-process, not with a killed process | Low | No |
| 11 | Evaluation store immutability | Harness is pure and writes nothing | `acceptance-ao09.test.js` 6 | None observed | None | No |
| 12 | Evaluation of executive handoff behavior | Handoff has dedicated suites | `handoff-integrity-ao.test.js`, `handoff-hash-binding-ao.test.js` | No handoff scenario in the evaluation harness | Low | No |
| 13 | Asymmetric contradiction retrieval | Retrieval bounds are disclosed; World Model conflict view is counts-only and whole-store | `cognition-evidence-states.test.js`, `world-context.test.js` | A contradiction whose counterpart is outside the retrieval bound is disclosed as an omission, not guaranteed retrieved | Medium | No |
| 14 | Duplicate evidence IDs within one claim | Duplicate reduction counts once | `acceptance-ao09.test.js` 3 | None observed | None | No |
| 15 | Evidence retraction between analysis and response | `recheckEvidence` + `#recheckAnswerEvidence`; notice; lineage unchanged | `acceptance-ao09.test.js` 4-5 | An unreadable record weakens to unverified rather than proving falsity, by design | Low | No |
| 16 | Remote synchronization uncertainty | None | `git fetch` fails here | `origin/main` is cached; no push verification possible | Medium | Yes, for publishing; no for runtime |
| 17 | Authorization/after-approval interruption boundaries | In-process refusal tests | `plan-adversarial.test.js`, `executive-acceptance.test.js` K-17/K-18 | No killed child at those instants | Low | No |
| 18 | An approved adaptation influences a decision other than candidate ordering | The decision block names `approved_adaptation_fit`, is computed after every gate, and is the only dimension the ledger feeds; `selection.js` binds the choice to the compared bytes | `adaptation-decision.test.js` (bounded influence), `plan-guidance.test.js` | The ranked dimension list is fixed in code; a record cannot add one | Low | No |
| 19 | The counterfactual disclosure costs a second Pareto pass | The same `dominance` rule is applied to the same rows without one dimension; measured before (pre-AP module) and after in one process | `adaptation-decision.test.js`; `benchmarks/run-adaptation-decision-benchmark.mjs` | Cost is quadratic in candidate count, as the comparison already was; measured about 0.04 / 0.01 / 0.41 ms at 4 / 10 / 20 candidates | Low | No |
| 20 | Reversal is prospective, not retrospective | `adaptation.retire` appends a lifecycle event; every read recomputes state | `adaptation-decision.test.js` (approval and reversal on identical fixtures) | An already-displayed decision is not rewritten; the next comparison restores the unadapted order. Historical audit lines are unchanged by design | Low | No |
| 21 | A supporting record outside the retrieval window influences nothing and is not named as applied | `guidanceFrom` admits only rows the learning read returned; `activeAdaptations` has a default window of 3 | `experience-*` suites, `plan-guidance.test.js` | The decision reports the records it was handed; it does not claim knowledge of records it never read | Low | No |
| 22 | An applied ordering could be read as a claim that the ordered approach will succeed | The rule is the user's recorded shape; no weight is fitted from outcomes and no causal effect is claimed | `plan-guidance.test.js`, `adaptation-decision.test.js` | Documentation states the limit; the block says `authorizes:false` and the note says it moved at most a comparison | Medium (interpretive) | No |
| 23 | An evaluated prediction could become evidence without the user's approval | Derivation only appends an unapproved candidate; `adaptation.decide` is the only approval, user-origin only, and both the display and the independent verification say the candidate is not approved | `prediction-adaptation-learning.test.js` (evaluation approves nothing; approval required), `adaptation-decision.test.js` | None observed; an evaluation and an approval are separate records | None | No |
| 24 | A prediction-derived rule could be read as proof APEX predicts accurately, or as a causal finding | The proposal is a closed mapping from recorded outcome class, carries four stated limitations, and `authorizes:false`; no probability, score, or fitted weight exists | `prediction-adaptation-learning.test.js` (typed proposal), `prediction-adaptation-boundary.test.js` | Documentation states the non-claims; the record shows the verdict it was read from | Medium (interpretive) | No |
| 25 | Re-evaluation or invalidation could leave stale guidance active | `#predictionCurrentness` re-reads the cited predictions (`predictions.details`, one batched ledger read per check) and forces `active:false` with a reason; no retention between checks | `prediction-adaptation-learning.test.js` (stale evaluation, unreadable ledger, withdrawal after approval) | An already-displayed decision is not rewritten; the next comparison reports the record inert | Low | No |
| 26 | Duplicate evaluations or duplicate evidence ids could amplify one prediction | One proposal per projection, one prediction and one evaluation in `support`, `minSupport:1`, duplicate derivation skipped, evidence lists deduplicated and bounded | `prediction-adaptation-learning.test.js` (duplicate derivation/citation) | None observed | None | No |
| 27 | The added currentness read makes a planning read cost more on large ledgers | It is one batched ledger read (`predictions.details`) per check for every active prediction-derived row, deliberately without retention between checks so stale evidence cannot be hidden | `prediction-adaptation-learning.test.js` (real store), `longitudinal-outcome-analysis.test.js` (batched vs per-citation equivalence), `benchmarks/run-longitudinal-benchmark.mjs` | The batched read is one whole-ledger parse per check, so cost still grows with ledger size and citation count; it is included in the complete request measurement, not subtracted | Low | No |
| 28 | A longitudinal pattern could be read as a causal or predictive claim | The vocabulary is closed and directional; the report and every proposal carry the "no causal claim, no confidence" note, and no probability or fitted weight exists | `longitudinal-outcome-analysis.test.js` (pattern disclosures), `prediction-adaptation-boundary.test.js` | Documentation states the non-claims; a reader can still over-read a repeated association | Medium (interpretive) | No |
| 29 | A pattern could be derived from a partial read of a large scope | The derivation read is bounded at 20 predictions; an over-bound read is disclosed and refuses a pattern rather than inferring from a prefix | `longitudinal-outcome-analysis.test.js` (bound and over-bound cases), `benchmarks/run-longitudinal-benchmark.mjs` (25-evaluation case) | A scope with more than 20 predictions yields no longitudinal candidate at all; that is a refusal to answer, not a wrong answer | Low | No |
| 30 | Aggregated evidence could approve or activate itself | `adaptation.derive` only appends an unapproved candidate; `adaptation.decide` is the only approval, user-origin only, and aggregation cannot retire, authorize, or start anything | `longitudinal-outcome-analysis.test.js` (aggregation approves nothing; only an approved adaptation moves the dimension), `adaptation-decision.test.js` | None observed; approval and derivation are separate records | None | No |
| 31 | A later positive outcome could be read as proof the approved rule caused it | The report states a recorded association only; the unadapted decision was disclosed but never executed, so its outcome is `unavailable` and never estimated; `authorizes:false` and the note say no causal claim is made | `adaptation-effectiveness.test.js` (counterfactual and summary cases), `benchmarks/run-effectiveness-benchmark.mjs` | A reader can still over-read an association; documentation states the limit | Medium (interpretive) | No |
| 32 | Approval or successful execution could be reported as an effective outcome | Classification keeps `approved_never_applied`, `applied_outcome_pending`, and `applied_successful` distinct, and only a plan assessment that established the outcome counts as success; execution verification alone does not | `adaptation-effectiveness.test.js` (lifecycle states, blocked/uncertain not failures) | None observed; the states are computed from separate records | None | No |
| 33 | A missing or conflicting record could be silently converted into success, failure, or a manufactured baseline | Missing evidence is `insufficient_evidence`; conflicting assessments are `applied_conflicting_evidence`; a cancelled plan is not a failure; no baseline outcome is synthesized | `adaptation-effectiveness.test.js` (conflicting assessments, cancelled, damaged stores) | The vocabulary bounds what can be said; nothing infers real-world truth | None | No |
| 34 | The read could approve, guide, retire, or execute during a review | Read action only; `authorizes:false`; retirement remains `adaptation.retire` and rule changes remain `adaptation.guide`; the independent verification refuses if any of those changed between its two reads | `adaptation-effectiveness.test.js` (retirement only through the existing operation; audit-append failure), `benchmarks/run-effectiveness-benchmark.mjs` (concurrent read/write refusal) | None observed; the read has no write path | None | No |
| 35 | A large store could make the read partial, slow, or lie about its scope | Bounds: 20 adaptations, 100 uses, 10 displayed samples per row (true counts still reported), 20,000 audit records scanned; over-bound reads disclose `truncatedUses`, and a damaged store raises `StoreError` | `adaptation-effectiveness.test.js` (bounded reads, damaged stores), `benchmarks/run-effectiveness-benchmark.mjs` (21-adaptation window case) | A target outside the newest 20 adaptations is not read at all; that is a disclosed refusal, not an inaccurate row | Low | No |
| 36 | A recommendation could be read as a governance decision | `recommendation` is derived from the report (`none`/`review`/`consider_retirement`); opening records only the review; only `adaptation.review.decide` records a decision, user-origin only | `adaptation-governance.test.js` (report states, lifecycle decisions) | Documentation states the limit; a reader can still over-read a recommendation | Low (interpretive) | No |
| 37 | A changed evidence digest could be read as better or worse | Reconciliation has a closed change vocabulary and no quality, success, or causal field; the report digest moves separately | `adaptation-governance.test.js` (each change kind; moved report digest alone) | The vocabulary bounds what can be said; nothing ranks a change | Medium (interpretive) | No |
| 38 | A review could be decided on evidence that changed | `recordReviewDecision` re-derives the bundle and refuses when the digest differs; the decision records the digest it was made on | `adaptation-governance.test.js` (changed digest requires a new decision; reconcile while deciding) | The check is a read immediately before the append; a concurrent append after that read is not eliminated | Low | No |
| 39 | A review retirement could bypass the existing retirement authority | `retire` appends the existing `adaptation_retirement` record through the existing authority, then the decision record; a changed-digest refused before retirement | `adaptation-governance.test.js` (retire through the review; concurrent open/retire) | It is the same authority, not a second mechanism; the decision record is separate bookkeeping | None | No |
| 40 | Model output could open or decide a review | The actions are user-origin only and the store refuses a non-user origin independently; the model-origin write set is unchanged | `adaptation-governance.test.js` (model cannot open/keep/dismiss/retire; store refuses again), `model-self-authorization.test.js` | None observed | None | No |
| 41 | Governance reads could add a second full analysis per row | The list is bounded at 20 rows and assembles a review bundle only when a review exists; the complete request is measured | `adaptation-governance.test.js` (bounded window), `benchmarks/run-governance-benchmark.mjs` | Cost still grows with history within the window; open, inspect, reconcile and decide repeat the analysis in verification and do not subtract it | Low | No |
| 42 | A target outside the 20-adaptation window could look governed when it is not listed | The list read reports the window and its totals; a direct detail read still answers by id | `adaptation-governance.test.js` (bounded window), `benchmarks/run-governance-benchmark.mjs` (21-adaptation case) | A user who only lists may not see an older adaptation; the list says the read was truncated | Low | No |
| 43 | A multi-store read could describe a combination of states that never coexisted | Identity before/after proves a quiescent window; a moved file is `concurrent_modification`; a read that still cannot be certified is refused with its attempt count | `evidence-fabric.test.js` (window states, concurrent writes, truncation), `benchmarks/run-evidence-benchmark.mjs` | A window is not a transaction and holds no lock; a rewrite preserving both size and mtime is invisible to `stat`, and the stores' hashing remains the authority | Medium | No |
| 44 | A damaged or truncated store could be reported as empty or valid | Health checks are normalised (`corruptLines`/`corrupt`, knowledge `claims`+`lifecycleEvents`); damage is a finding about records read; a truncated child tail is `damaged_store` | `evidence-fabric.test.js` (damaged/truncated stores, cross-process child), `store-health.test.js` | A store with no health check is described by identity only; absence of a check is not evidence of damage | Low | No |
| 45 | A bounded read could be read as a negative fact | Limits map to `valid_bounded`; `out_of_window`/`unread` are not `missing`; the adaptation window now discloses `truncatedSources` | `evidence-fabric.test.js` (reference mapping, adaptation-window clipping), `adaptation-effectiveness.test.js` | Only the adaptation window was newly disclosed; other bounds were already stated, and a record outside a window is still not named | Low | No |
| 46 | A window that cannot be certified could be silently downgraded | Refusal is explicit: `available:false`, `state`, `attempts`, no rows and `totals:null`; `unverifiable` is never retried; review stages raise `StoreError` | `evidence-fabric.test.js` (refused governance, unverifiable store), `adaptation-effectiveness.test.js` | Cognitive retrieval, world state and the prediction projection remain per-store atomic and disclose an unavailable source; none claims cross-store consistency | Medium | No |
| 47 | Integrity metadata could be read as authority or as proof of truth | `authorizes:false` on every report; the note states that a digest proves bytes did not change, never that records are true; nothing reads integrity to decide an action | `evidence-fabric.test.js` (authorizes false, digest stability), `model-self-authorization.test.js` | A reader can still over-read a digest or a `valid` state; documentation states the limit | Medium (interpretive) | No |
| 48 | A retry could hide the write that caused it | Retries are bounded at three, occur only after a verdict, and the attempt count is reported with the result; a writer active for the whole budget still yields a refusal | `evidence-fabric.test.js` (two writes then a certified third attempt; a write in every attempt) | The retry re-reads the whole report; it is not incremental, and the cost grows with the report, not with the retry count | Low | No |
| 49 | A content-certified window could be read as a transaction or as authority | The digest is part of the identity; every report carries `authorizes:false`; the note says a consistent window proves bytes did not change, never that records are true | `ap07-consistency.test.js`, `evidence-fabric.test.js` | A reader can still over-read a digest; documentation states the limit | Low | No |
| 50 | A same-size rewrite could pass a metadata-only window | Content certification is the default; `content:false` is explicit and reports `metadata`; `content_changed` and `replaced` are named change kinds | `ap07-consistency.test.js` (same-size rewrite), `evidence-read-contract.test.js` | A same-size rewrite restored to the original bytes between the two inspections is invisible to any before/after comparison | Medium | No |
| 51 | A consumer could combine records from a moved window and still state a pattern | Longitudinal withholds every pattern on a moved or truncated read; world certification never promotes completeness; retrieval reports the bundle as `unverifiable` or `inconsistent` | `ap07-consistency.test.js` §4-§7, `longitudinal-outcome-analysis.test.js` | Health reads and single-store lists remain atomic per store and are not windowed | Low | No |
| 52 | A refused assessment could be recorded as an input error or as a partial success | `plan.assess` raises `EVIDENCE_WINDOW_UNCONFIRMED`; the executor reports `failed`; the controller reports `EXECUTION_FAILED`; no assessment is recorded | `ap07-consistency.test.js` §7 (moved window), `plan-continuation.test.js` | The refusal names the observed change, not its cause | Low | No |
| 53 | A bounded read could prove an absence it did not prove | `absenceProven` holds only for `complete_empty`; a bounded, truncated or unavailable read leaves absence unproven, and the nine-state contract says which was observed | `evidence-read-contract.test.js`, `ap07-consistency.test.js` §8 | A caller that ignores `absenceProven` can still misread an empty bounded read; the API exposes the distinction | Low | No |
| 54 | Snapshot reuse could hide a later write inside one operation | Reuse is one promise per label per operation and is never persisted; the second read is the same bytes by construction, and the window's end inspection still runs | `ap07-consistency.test.js` §3, `run-consistency-benchmark.mjs` (reuse section) | A caller that needs a later read must open a new snapshot; there is no cache across operations | Low | No |
| 55 | A stage that never ran could be read as a check that ran and found nothing | Statuses are distinct; `not_reached` and `unavailable` are excluded from `reachedThrough`; grounding before a model reply exists is `not_reached` | `cognition-response-integrity.test.js` (contract, clarification, cancellation) | A consumer that counts stages instead of reading statuses can still misread the contract | Low | No |
| 56 | A fluent answer could acquire factual authority from relevance | The trust ladder's top rung is `factually_supported`, which requires every factual claim to be cited and restate a current record; `verified` is `ok:false` unconditionally | `cognition-response-integrity.test.js` (unsupported claim, attribution, forbidden fields) | Attribution is lexical overlap, not entailment; a paraphrase with low overlap is reported `unattributed` | Medium | No |
| 57 | A citation could be checked while the sentence it supports is false | `assessClaimAttribution` compares content words and digits per claim and reports `unattributed` on a number mismatch; the limitation `claim_attribution_unverified` is set | `cognition-response-integrity.test.js` 23, 28-scenario table | Word overlap cannot detect a claim that inverts or negates its record; documentation states this limit | Medium | No |
| 58 | A rejected structure could still leave claims counted as attributed | A rejected reply reaches the reader as a plain answer; attribution failures are zero and a `structured_response_rejected` limitation is set | `cognition-response-integrity.test.js` 14, 15, 17 | None observed | None | No |
| 59 | Degradation wording could upgrade an answer | `present_as_is` requires `factually_supported` with the single limitation `model_output_unverified`; every other case is `present_with_limitations` or `no_output` | `cognition-response-integrity.test.js` (degradation cases, refusal, cancellation) | A reader can ignore the qualification; the notice is present in the text | Low | No |
| 60 | A grounded answer could be read as execution authority | The contract and handoff are separate objects; the handoff names its authority owner and carries `authorizes:false`; a denial is audited | `cognition-response-integrity.test.js` §9, `handoff-integrity-ao.test.js`, `model-self-authorization.test.js` | None observed; the proposal path was not changed | None | No |
| 61 | An unreadable proposal tally could be reported as zero proposals | A non-integer tally makes stage 14 `unavailable` and the counts are dropped rather than zeroed | `cognition-response-integrity.test.js` (malformed tally) | None observed | None | No |
| 62 | Audits could leak request or model prose | Both audit builders use fixed key sets and integer counts only; no text, prompt or reply field exists | `cognition-response-integrity.test.js` (audit shapes) | A new field added later could leak; the key list is asserted by the suite | Low | No |
| 63 | A claim could reverse a negation, change a number or swap a name and still be lexically attributed | AP-09 compares polarity, quantities, dates, entities, relationships, qualifiers and transformations against the cited records before factual support is granted | `semantic-consistency.test.js` (every dimension, 28 attack classes), `semantic-acceptance.test.js` | The rules are finite lists and patterns; a paraphrase, metaphor, implication or novel causal argument is not detected and is reported `insufficient_evidence` or `not_checked` | Medium | No |
| 64 | Another dimension could downgrade a conflict, or a short claim could lose its conflict | Precedence is applied to the set of findings the claim produced; a conflict outranks ambiguity and partial readings, and a single shared content word is enough to run the dimensions | `semantic-consistency.test.js` (precedence, one-word overlap, multi-axis cases) | A conflict on a dimension with no shared vocabulary remains outside the check; that is reported as insufficient overlap, not as consistent | Low | No |
| 65 | A check that could not run could be read as a check that passed | `not_checked` and `unavailable` are separate outcomes; `factually_supported` requires `semantically_consistent`, so neither can support it | `semantic-consistency.test.js` (read window, missing record), `semantic-acceptance.test.js` | A consumer that reads only the trust state still needs the limitation list to see why support was withheld; the notice is present | Low | No |
| 66 | Evidence could move between retrieval, assessment and display | The AP-07 window state drives `unavailable` or `not_checked`; the late recheck still only weakens; the window failure is an evidence result, not `execution_failed` | `semantic-acceptance.test.js` (write during the window, post-answer change), `ap07-consistency.test.js` | A same-size rewrite restored to its original bytes between inspections remains invisible, as for every AP-07 window | Medium | No |
| 67 | A semantic label could be read as understanding, entailment or verified truth | The vocabulary is a fixed list of bounded findings; every assessment and the audit carry `authorizes:false` and `factualAuthority:'none'`; documentation disclaims NLU and entailment | `semantic-consistency.test.js` (authority fields), `semantic-acceptance.test.js` (self-verification rejected) | A reader can still over-read "consistent"; documentation states the limit | Medium (interpretive) | No |
| 68 | The semantic audit could carry claim or record text | The block is fixed-key and holds labels, non-negative counts, dimension statuses and at most six index pairs; the AP-08 suite asserts the key set and the absence of a secret | `cognition-response-integrity.test.js` (audit keys), `semantic-consistency.test.js` (audit) | A field added later could leak; the key list is asserted by the suite | Low | No |
| 69 | The added check could make every grounded reply slower | At most six records per claim, twelve claims and six pairs per response; the module and the complete request are measured in one run | `semantic-consistency.test.js`, `benchmarks/run-semantic-validation-benchmark.mjs` | The per-claim comparison grows with claim count up to the fixed bound; the request cost is dominated by the stores' search and parse, and the benchmark is a single-run observation | Low | No |
| 70 | A historical plan approval could be read as current authorization | `planRow.approval.usable` is always false; running a plan today revalidates version and content hash through the existing approval path | `executive-history.test.js` (approved later, approval invalidated later, later draft revision, later assessment) | A reader can ignore `usable:false`; the field and the documentation state it | Medium (interpretive) | No |
| 71 | A later revision or approval could lend authority to an earlier plan version | The reducer keeps the version current at the cutoff; an approval names the version and content hash it bound, and a revision after the cutoff appears only as a `later` flag plus a separate `now` block | `executive-history.test.js` (plan version and approval cases) | None observed | None | No |
| 72 | The operations audit log could be read as a cutoff answer | `supportsCutoff:false` and `recordedAtKnown:false` are fields; each row is `later`, `finished_by_cutoff`, `unrecorded_finish` or `unknown`, and `existedAtCutoff` is `unknown` unless the record provably finished after the cutoff | `executive-history.test.js` (operation finished later, verification later) | Whether a line that finished by the cutoff was written before or after it is not recorded anywhere, as documented | Low | No |
| 73 | A missing or unreadable audit line could be read as success, or as proof an operation never ran | Citations distinguish `missing` (no corrupt lines and no matching id), `unavailable` (log unread or corrupt lines present, so absence is unestablished) and `unknown`; no citation state asserts success | `executive-history.test.js` (missing citation, corrupt audit line) | Damage to a store outside the four executive sources is reported under that store's own status, not by the citation row | Low | No |
| 74 | A record stored by the cutoff could cite an operation that finished after it | Such a citation is reported `later` with `inconsistent:true` and is not used as past evidence; the record is not rewritten | `executive-history.test.js` (later-citing goal evidence) | None observed | None | No |
| 75 | A cutoff subsequence could be silently reordered or dropped to make it apply | `historicalView()` replays the whole log first; a full log that applies while its cutoff subsequence does not is `inconsistent` with the reducer problems named, never reordered, and the other sources still answer | `executive-history.test.js` (non-monotonic clock, damaged goal log) | The combined view is then not `complete`; that is disclosed per source, so a certified conclusion is not produced | Low | No |
| 76 | The persisted audit copy could disagree with the read it records | Bounded history rows nest evidence ids deeper than earlier payloads, so the shared redaction depth cap was raised from 8 to 10 and a test asserts the criterion-to-operation id survives in `step.result` | `executive-history.test.js` (completion citation in the action result) | A future payload deeper than 10 would again be replaced by a length marker; the cap remains a hard bound | Low | No |
| 77 | A reconstruction could be mistaken for replay, resumption or authority | The action is read-only and unplannable, carries `authorizes:false`, and refuses unexpected input fields; tests assert the data directory is byte-identical after goal, plan and task reads and that a read never resumes a task | `executive-history.test.js` (action contract, adversarial input, model origin, read never resumes) | Model origin may read history; it still cannot create, approve, execute or resume anything | Low | No |
| 78 | A later memory correction could rewrite what an earlier cutoff is shown to have held | The past listing derives from records appended by the cutoff; a correction written later is absent from the rows and reported as `later` flags plus a separate `now` block | `memory-knowledge-history.test.js` (correction after the cutoff; multiple corrections across three cutoffs) | An earlier belief later found wrong still reads as the belief recorded then; that is the record model and is stated in the limitations | Medium (interpretive) | No |
| 79 | A derived memory conflict could be read as a recorded event | Conflict groups are the store's read-time clause rule; the view and the limitation state that the store records no conflict event | `memory-knowledge-history.test.js` (conflict before the cutoff, later correction) | A later correction clears the present group but never the past reading | Low | No |
| 80 | Private memory could reach a model through a historical read | Private records are excluded from rows by count in both the store view and the section; a model-origin read asserts the private content string is absent | `memory-knowledge-history.test.js` (private exclusion, model-origin read) | None observed | None | No |
| 81 | A later knowledge resolution could claim an earlier conflict was already resolved | Claims and both event kinds are filtered by `createdAt` before deriving; a later resolution is a later count, not an earlier state | `memory-knowledge-history.test.js` (conflict unresolved at the cutoff despite a later resolution) | None observed | None | No |
| 82 | A later knowledge retraction could erase the fact that a claim existed at the cutoff | Retraction events are later records and absent from the past derivation; the earlier claim is shown as it stood then, with the later retraction disclosed | `memory-knowledge-history.test.js` (retraction after the cutoff; successor does not retroactively supersede) | None observed | None | No |
| 83 | Free-text knowledge evidence could be read as a record citation | The section labels `evidence` as free text; only `provenance.operationId` is resolved, against the audit log, with `later`, `missing` and `unavailable` states | `memory-knowledge-history.test.js` (free-text evidence, missing and later citations) | A reader may still over-read an evidence string; documentation states the limit | Medium (interpretive) | No |
| 84 | A damaged memory store could hide the knowledge answer, or vice versa | Per-source status and reason; the other section still answers, the combination is not `complete` or `verifiable`, and the operation stays `SUCCESS_VERIFIED` because the read was reproducible | `memory-knowledge-history.test.js` (corrupt memory with knowledge readable and the reverse) | What a damaged source held cannot be established; absence is not proven | Low | No |
| 85 | A historical listing could be mistaken for current memory or alter retrieval | The sections are read-only, unplannable and consumed by no retrieval path; a byte-identical guard covers both stores, and model origin may read but cannot write | `memory-knowledge-history.test.js` (read-only bytes, model-origin denial, adversarial input) | A model can read history; it cannot promote a record into current memory or knowledge | Low | No |
| 86 | A deterministic offline answer could be read as model prose or a verified action | The outcome is `success_deterministic`, distinct from `success_verified` and `verification_unavailable`; the display states no model was used and the answer is a bounded cited reading; the audited output is content-free; automatic capture and goal completion both exclude it | `offline-answer.test.js` (status, content-free audit, no model prompt, CLI exit 0) | A reader may still over-read a cited reading as generated prose; the display and the outcome name the limit | Medium (interpretive) | No |
| 87 | A task run/resume/retry could leave its plan stale, duplicate an outcome event, or auto-complete a goal | `#syncPlanFromTask` reads the plan first and records only outcomes it does not already hold through `reconcilableOutcomes`, the same rule the reducer applies on replay. A completed/skipped result is final, an uncertain result may be replaced by a later reading, and a failed result may be replaced only by a non-completed one; a failed step completed later needs a new plan revision and is disclosed, not recorded. Status moves only along the reducer's permitted transitions, and a blocked plan is reopened only when every step holds a completed verified outcome. A repeated sync appends nothing. A goal is completed only by the user against its criteria | `task-plan-reconciliation.test.js` (8 cases: activation-recorded outcomes then standalone resume; uncertain recovery; failed step stays failed; repeated sync idempotent; standalone task; plan-write failure disclosed; real cross-process interruption) and `task-plan-sync.test.js` (interrupted resume completes the plan; standalone task unchanged) | A plan-write refusal is surfaced as a note rather than failing the task; the task's verified result is never rewritten | Low | No |

No gap in this register was implemented in AO-10: none exposed a new concrete defect in behavior,
and none invalidated a documented security guarantee. AP-01 closed the roadmap's "one recorded
outcome changes exactly one later disclosed decision" clause for the user-approved adaptation
signal only, and added rows 18–22 for what that does not claim; the `getMany` contract defect found
in AO-09 had already been fixed there with a regression test. AP-02 added rows 23–27 for the
prediction-derived signal: it closed the "an evaluated prediction may inform one later decision"
clause under explicit user approval, and left the accuracy, causal and autonomy claims open.
AP-03 added rows 28–30 for the longitudinal signal: bounded repeated-outcome analysis may describe
one scope and become a candidate under the same explicit approval, and it still claims no causation,
no confidence, and no autonomous activation. AP-04 added rows 31–35 for the effectiveness read: it
traces an approved record through the decisions it was part of to the outcomes those plans recorded,
keeps approval, application, execution, assessment and cause apart, discloses insufficient and
conflicting evidence, and grants no approval, rule change, retirement, or execution authority.
AP-05 added rows 36–42 for the governance review: it binds a review to a canonical evidence snapshot,
derives its state on every read, names reconciliation differences without ranking them, and keeps
approval, rule change, retirement and execution in their existing operations. The retirement decision
reuses the existing authority rather than adding a second one, and the remainders it leaves open are
concurrent-append timing and interpretive over-reading, not new authority. AP-06 added rows 43–48 for
the cross-store read window and the integrity vocabulary: a report assembled from several append-only
stores now proves no contributing file moved while it read, names what it found in one closed
ten-state vocabulary, refuses a combination that did not exist at one instant, and discloses a
clipped adaptation window. The window is a proof of quiescence, not a transaction, holds no lock, and
cannot see a same-size, same-mtime rewrite. AP-07 added rows 49-54 for consumer-wide consistency: the
request path's retrieval, world-state and prediction readers now read their contributing stores inside
one content-certified window and report the nine-state read contract, or state why they could not; a
refused assessment is an execution failure, not an input error; reuse is per operation and never
persisted; and no verdict authorizes an action. AP-07 does not make every read in APEX windowed -
health reads and single-store lists remain atomic per store - and a window still cannot see a
same-size rewrite restored to its original bytes. AP-08 added rows 55-62 for grounded response
integrity: the request path now states its fourteen stages with statuses that keep a stage that never
ran apart from one that ran with no result, grades each claim against the record it cites, and caps
model prose at `factually_supported` because a citation check is not verification. Its stated limits
are that attribution is lexical overlap rather than entailment, that an answer can still be fluent and
wrong within a supported citation, and that the 28-scenario table is a deterministic fixture set and
says nothing about a real model's answer quality. AP-09 added rows 63-69 for semantic grounding: a
factual claim is now compared with the records it cites on eight bounded dimensions, a conflict is
never downgraded, ambiguity is never support, a missing or unavailable check stays distinct from a
passed one, and `factually_supported` additionally requires semantically consistent wording and no
contradiction between claims. The limits it states are that the comparison is finite lexical and
structural analysis rather than natural-language understanding or entailment, that a paraphrase or
an implication can fall outside it and is then reported as insufficient or not checked, and that the
attack fixtures were written to be decidable by the rules.

AP-17 added rows 70-77 for historical executive state: a goal, plan or task log now answers a cutoff
through its own replay, a later completion, approval, revision, assessment or outcome is reported
beside the past row rather than merged into it, a historical plan approval is never usable, and the
operations audit log states that it cannot answer a cutoff at all. Its stated limits are that the
audit log carries no recorded-at so an append can never be placed at an instant, that a citation to an
operation finishing after the cutoff is disclosed as inconsistent rather than repaired, that a
cutoff subsequence which does not apply leaves that source `inconsistent` and the combined view not
`complete`, and that a read reconstructs state without replaying, resuming or authorizing anything.

AP-18 added rows 78-85 for historical memory and knowledge: the same reconstruction now lists each
store as of the cutoff, so a later correction, retraction, supersession or resolution is disclosed
beside the past row instead of applied backwards, private memory is excluded from a read that a
model origin can run, and a damaged store is named while the other still answers. Its stated limits
are that memory has no event time, valid interval, retraction or conflict event, so a later-corrected
claim still reads as the belief recorded then and a conflict group is content-derived; that a
knowledge resolution is a recorded decision, not truth; that free-text `evidence` is not a record
citation; and that both listings replay the whole log, so the output is bounded but the read cost is
not.

Batch PC added five capability rows without adding a store, registry, controller, authorization rule
or model call. The limits it states are that the workspace surface has no delete, move, rename or
directory create and cannot replace a file without its current hash; that the digest reports the two
stores separately and decides which source is right for neither; that the work portfolio reports
stored status and recorded dates without scheduling, prioritizing or acting, and a missing date is
"no date recorded"; that outcome feedback is refused unless a verified run supports it and changes
nothing until a derived candidate is explicitly approved; and that the practical evaluation is a
deterministic fixture set over APEX's own paths, so it says nothing about real-world task success or
answer quality.

## 10. Running the verification

```sh
cd apex_app
npm test                       # every suite named in package.json
node --test tests/cognition-lifecycle.test.js tests/cognition-artifacts.test.js
node --test tests/acceptance-ao09.test.js tests/cross-process-ao09.test.js
node --test tests/adaptation-decision.test.js
node --test tests/prediction-adaptation-learning.test.js tests/prediction-adaptation-boundary.test.js
node --test tests/longitudinal-outcome-analysis.test.js
node --test tests/adaptation-effectiveness.test.js
node --test tests/adaptation-governance.test.js
node --test tests/evidence-fabric.test.js
node --test tests/evidence-read-contract.test.js tests/ap07-consistency.test.js
node --test tests/cognition-response-integrity.test.js
node --test tests/semantic-consistency.test.js tests/semantic-acceptance.test.js
node --test tests/temporal-belief.test.js tests/history-reconstruction.test.js tests/executive-history.test.js tests/memory-knowledge-history.test.js
node --test tests/capability-eval.test.js
node --test tests/practical-eval.test.js tests/workspace.test.js tests/knowledge-digest.test.js tests/work-review.test.js tests/task-feedback.test.js
node --test tests/t14-workflows.test.js tests/t14-health.test.js tests/t14-reliability.test.js tests/t14-scale-bounds.test.js
APEX_DATA_ISOLATED=1 node benchmarks/run-t14-scale-benchmark.mjs
node benchmarks/run-cognitive-runtime-benchmark.mjs
node benchmarks/run-adaptation-decision-benchmark.mjs
node benchmarks/run-prediction-adaptation-benchmark.mjs
node benchmarks/run-longitudinal-benchmark.mjs
node benchmarks/run-effectiveness-benchmark.mjs
node benchmarks/run-governance-benchmark.mjs
APEX_DATA_ISOLATED=1 node benchmarks/run-evidence-benchmark.mjs
APEX_DATA_ISOLATED=1 node benchmarks/run-consistency-benchmark.mjs
APEX_DATA_ISOLATED=1 node benchmarks/run-response-integrity-benchmark.mjs
node benchmarks/run-semantic-validation-benchmark.mjs
```

Tests use `NoBackend` or fixed programmatic replies and isolated temporary data directories. No
test downloads a dependency, starts a model server, or contacts a model endpoint. Benchmarks write
only to fresh temporary directories. The complete measured tables and their caveats are in
[`README.md`](README.md#benchmarks).

## 11. What this document does not claim

- It does not claim the APEX vision is complete. `apex_app/` is a vertical slice.
- It does not claim a real model satisfies the cognitive contract; no test runs one.
- It does not claim verification establishes real-world truth, or that a passing suite establishes
  security.
- It does not claim remote synchronization; the configured remote is unreachable from this machine.
- It does not claim the neural research tree is integrated; `stark/` is separate and is not imported.
- It does not claim a neural runtime exists. A versioned proposal contract and its refusals are
  implemented and tested against a deterministic simulated transport, which is evidence about the
  boundary, not about a model.
- It does not claim an approved adaptation improves work. It claims that, when the user approved a
  shaped record and its evidence still stands, the recorded shape can reorder the approaches the
  comparison already admits; that the order the same rule would have produced without it is shown
  beside the order it produced; and that retirement restores the unadapted order without erasing
  history. It does not claim that the earlier outcome caused the later success.
- It does not claim APEX predicts accurately or learns causally. AP-02 claims only that one completed
  evaluation of one user-recorded expectation can become a bounded candidate, that the candidate is
  evidence only after the user approves it, and that the resulting ordering influence is disclosed,
  reversible and grants no authority. It does not claim a prediction is a probability, that the
  evaluation is independent of the user's expectation, or that any of this improves future work.
  It does not claim autonomy: every transition from recorded evidence to an applied rule requires a
  user action.
- It does not claim AP-03 identifies causes, states a confidence, forecasts, or learns on its own.
  It claims only that a bounded, scoped, deduplicated sequence of user-recorded expectations and their
  recorded verdicts can be described with a closed vocabulary, that a directional pattern can become
  a candidate, and that only the user's explicit approval lets that candidate reorder one disclosed
  comparison. A repeated association in recorded order is not evidence that the capability caused the
  outcome.
- It does not claim every read in APEX is window-certified. AP-07 covers the consumers that combine
  several stores into one answer; health reads, single-store lists and store-level operations remain
  atomic per store. A content-certified window proves the bytes did not change between two
  inspections; it is not a transaction, holds no lock, and cannot see a same-size rewrite restored to
  its original bytes between them.
- It does not claim APEX verifies what a model says. AP-08 claims that a response states which stages
  ran, that each claim is graded against the record it cites, that a claim restating a cited record is
  distinguished from one that only shares a subject, and that degradation is deterministic and
  disclosed. It does not claim attribution proves entailment - the comparison is lexical, and a claim
  that negates or inverts its record can still overlap it - that `verified` is reachable for model
  prose, or that the deterministic 28-scenario table says anything about a real model's answer
  quality.
- It does not claim APEX understands language or performs entailment. AP-09 claims that a factual
  claim is compared with the records it cites on eight bounded lexical and structural dimensions,
  that a detected conflict, ambiguity, missing check or unavailable read is labelled and cannot be
  read as support, and that `factually_supported` now also requires consistent wording and no
  contradiction between claims. It does not claim a paraphrase, metaphor, implication or novel
  causal argument is detected; those fall outside the rules and are reported as insufficient or not
  checked. The vocabulary is finite, the fixtures were written to be decidable by it, and no model
  was consulted.
- It does not claim Batch PC makes APEX a general personal assistant. It claims that bounded
  workspace reads, one hash-guarded write, a cross-source digest, a recorded-work portfolio and
  user-confirmed task feedback run through the existing controller, stores, audit and authorization
  paths, and that the adversarial cases in their suites are refused as documented. It does not claim
  file deletion, movement, renaming, directory creation, automated replacement, or execution of file
  content; that the digest decides which source is right or merges stores; that the portfolio
  schedules, ranks or infers a missing date; or that feedback changes anything before the existing
  derivation and user approval run. A deterministic fixture passing a practical dimension is not
  evidence that the corresponding real-world outcome was achieved.

## T-09 situational awareness

`src/situational/` is one append-only `situational.jsonl` with four record kinds: `event_observed`,
`event_assessed`, `response_decided`, `response_recorded`. `store.js` holds the writer lock and
replays the log for every read; `significance.js` is a pure rule function; `service.js` normalises
events, writes facts/events through the existing `WorldModelStore`, reads goals, plans, tasks,
predictions and world conflicts, and records the loop. `src/actions/situation-actions.js` exposes the
eight registered capabilities; `controller.situationExecute` is the only path that runs anything and
it uses the existing `runAction`, registry, verifier and audit finalisation. Responses are recorded
as ordinary experiences, which is how T-08 sees them. The CLI and `ui/server.js` read the same
service; neither adds an authorization rule or a store.
## T-10 executive runtime (as implemented)

`src/runtime/` adds a process around the existing executive. It does not add a capability to the
registry and does not change the authority map: `controller.planActivate` remains the single path
from an approved plan to an action.

| Module | Responsibility | Authority | Failure behaviour |
| --- | --- | --- | --- |
| `vocabulary.js` | Closed lifecycle, default config, retry policy, failure statuses, bounded queue names | None | A value outside the vocabulary is a validation error |
| `state.js` | `runtime.json` checkpoint, canonical SHA-256 checksum, atomic replace, writer lock, quarantine | Reads and writes only its own file | Unparseable or checksum-mismatched state is moved to `runtime.corrupt-<ts>.json` and reported, never restored |
| `lease.js` | `runtime.lock` with pid, runtime id and nonce; exclusive create; stale-lease takeover; heartbeat | Exclusion only; grants no action | A live holder is never evicted; a failed heartbeat stops the tick without claiming work |
| `executive-runtime.js` | Lifecycle, automatic publication, event decisions, scheduler, notifications, diagnostics, T-08 link | Calls the situational service and `controller.planActivate`; never executes an action itself | A tick failure is recorded and the runtime stays running; retries are bounded and dead-lettered |
| `cli.js` | Start/stop/status/diagnose/tick/pause/resume/schedule/notifications | User-origin commands only | Usage errors exit 2; a refused start or tick exits 1 with the reason |

Lifecycle is `stopped -> starting -> running -> stopping -> stopped`. `start()` loads the checkpoint,
takes the lease, verifies dependencies (controller, situational service, task store, plan store, audit
log), records interrupted tasks, then enters `running` and publishes `runtime_started`. `stop()` clears
the timer, waits for an in-flight tick, publishes `runtime_stopped` and releases the lease. The
in-process active set and the file lease are independent duplicate-worker guards.

Publication uses one source identity per stored transition, e.g. `task:<id>:completed` or
`plan:<id>:cancelled`; identities longer than the situational log's 64-character source-id limit are
digested. A published key is checkpointed only after ingestion succeeds, and ingestion is itself
deduplicated by source identity, so a crash between the two writes cannot create a second event.
Runtime-published `runtime_*` events are marked processed without a decision, which terminates the
publication/processing loop.

Event processing reads at most the configured batch (five by default) from the bounded backlog,
orders by significance level then ingestion time, skips event ids already in the checkpoint, and
records one decision per event through `situation.decide`. It never calls `situation.execute` and
never supplies action input from an event. A processing error gets one retry and then a dead letter;
dead letters are bounded and never retried silently.

Scheduling mirrors, but does not replace, the runner's gates: plan must be `approved`, goal must be
open, goal dependencies must be `completed`, an explicit schedule must be due, no task for the plan
may be `proposed`/`running`/`paused`, and a retry's `nextAt` must have passed. One plan runs per tick.
`planActivate` re-reads authorization and verifies every step. Successful completion removes the
schedule and records a T-08 evaluation; failure schedules a retry with `baseDelay * multiplier^(n-1)`
and dead-letters at the limit.

Notifications are derived from recorded decisions, keyed by decision id, so replay cannot duplicate
them. They carry a level, expiry, suppression flag from T-09's cooldown/dedupe decision, and
acknowledgement. Acknowledgement is a state change only; it does not execute anything.

`runtime.status()` is a read model over the checkpoint plus task, plan and situational summaries. It
reports the lease holder, backlog, schedules, retries, dead letters, interrupted work, active plans,
recent history, configuration and the last error. `runtime.diagnose()` checks identity, checkpoint
integrity, dependencies, single instance, runner/audit availability, the situational log, the task
log, interrupted work and the absence of an inference handle. The UI exposes the status at
`GET /api/runtime` and in a read-only panel; the CLI renders the same fields.

The runtime uses no model gateway, downloads nothing, launches no inference server and makes no
network request. `neural` contracts remain untouched and unconnected.

## T-11 external event and integration fabric (as implemented)

`src/integrations/` adds providers around, not inside, the executive. It has no action registry, no
authorization rule, no event store and no execution path. `IntegrationFabric` is constructed once in
`app.js`, passed to `ExecutiveRuntime`, and exposes only configuration, polling and read models.

| Module | Responsibility | Authority | Failure behaviour |
| --- | --- | --- | --- |
| `vocabulary.js` | Provider ids, version, permissions, closed limits, sensitive names, schema | None; vocabulary only | Out-of-range values are validation errors |
| `model.js` | Configuration/observation validation, canonical hashing, secret-aware text, stable wire source ids | None | Malformed or oversized observations are refused per item |
| `store.js` | Checksummed atomic `integrations.json`, writer lock, corruption quarantine | Own file only | A bad document is quarantined and reported, never trusted |
| `registry.js` | Immutable builtin provider contracts and test/extension injection | Discovery only | Duplicate or invalid provider ids are refused |
| `manager.js` | Enable/configure/pause/reset, bounded poll, timeout/abort, retry, health, ingest bridge | Calls `situation.ingest` only; never executes an action | One provider's failure is isolated; retries are bounded and the runtime sees the outage |
| `providers/filesystem.js` | Metadata scan of explicit roots; create/modify/delete/rename detection | Read-only metadata | Root unreadable fails the poll; truncation suppresses deletion detection |
| `providers/system-health.js` | Memory/process/`statfs` metrics; threshold transitions and periodic summary | Read-only system values | Per-volume failures are reported as unavailable, not inferred pressure |
| `providers/calendar.js` | Deterministic configured schedule and time observations | Read-only configured data | Invalid timezone/offset/order refuses configuration |
| `providers/external-service.js` | Allowlisted outbound JSON GET, byte cap, scalar metadata extraction | Read-only network GET | Timeout, HTTP error, oversized/malformed response fails the poll |
| `cli.js` | `source` lifecycle/inspection/poll/reset commands | User-origin commands only | Usage errors exit 2; refused operations exit 1 |

Every provider implements `apex.integration.provider/1`: id, name, declared permissions, defaults,
`validate`, `scopeOf`, `poll` and `describe`. A poll receives only its configuration, checkpoint,
clock, data directory and an `AbortSignal`; no controller, action registry or model. Construction
creates no connection and the store is not written by reads. Disabled providers are skipped before
their `poll` is called. Enabling is explicit, and every provider is disabled initially.

Observation normalization runs before ingestion. It enforces a 64-character source key, a snake_case
type, bounded safe summary, finite/UTC-safe times, confidence, empty-or-declared entity/goal/plan/task
references, a 4 KiB payload and no null bytes. `wireSourceId` produces `provider:key` when legal and
otherwise `int:<digest>`, so a replay maps to the same T-09 event. The fabric passes the result to
`situation.ingest` with `source: "external_provider"`, provider provenance and the provider's
checkpoint. It does not write `situational.jsonl`, `runtime.json`, the world model or the audit log
itself. T-09 decides duplicate/replay/stale/conflict handling and significance; T-10 decides what is
recorded, recommended or notified. Providers cannot supply action input, and observation text is
static data.

Health and checkpoints are per provider: last attempt/success/error, consecutive failures, counts,
duration, next attempt, bounded recent rows and bounded errors, plus provider-owned checkpoint data.
A successful poll clears the outage and emits one recovery event; the first failure in an outage
emits one unavailable event. Retry delay is exponential with a hard attempt limit, and a forced poll
can retry after exhaustion but remains bounded and cancellable. `disable` and `pause` abort an
in-flight poll. `#persistProvider` merges only health/checkpoint after a slow poll, so a concurrent
disable or configuration change is not overwritten. Scope changes and explicit resets clear only the
provider checkpoint and append history with a reason; they never delete situational events.

Filesystem scope is resolved absolute directories, never a filesystem root, with 1–5 roots, bounded
depth/file count, extension filters, and sensitive segments/files refused before stat/read. The scan
uses `readdir({ withFileTypes: true })`, skips symlinks and non-files, and never calls a read API.
Rename detection matches an inode, then birthtime+size+root; it is heuristic. A scan that hits the
file cap marks itself truncated and suppresses deletion observations, preventing a bounded scan from
looking like mass deletion. A configured root that cannot be listed fails the provider; a failed
subdirectory is a warning. Checkpoints retain a bounded map of relative paths and metadata.

System health uses only `node:os`, `process` and `fs.statfs`; no privileged command, shell, process
inspection or network. Memory and disk threshold transitions and a periodic snapshot become
observations; the checkpoint's path scope is hashed so changing inspected paths invalidates the
disk baseline. Calendar configuration requires explicit UTC offsets, checked IANA zones, valid
start/end order and bounded events. Schedule metadata is separated from approaching/started/ended
time observations, and a changed schedule uses a new stable identity.

The external service is a real outbound adapter, not a mock in production code: a GET with
`redirect: "manual"`, no credentials, no query/fragment, an exact origin allowlist, a response byte
cap and a JSON list/`observations` envelope. Only bounded scalar properties are retained; a response
cannot supply a URL, method, header or executable instruction. Tests point it at a local HTTP server;
credentialed connectors remain a future contract. Any actual third-party use is still a user-
configured endpoint, not an implicit connector.

Wiring: `app.js` creates the fabric after T-09 and passes it to `ExecutiveRuntime`; each bounded tick
calls `pollDue({ limit: maxProvidersPerTick })` before lifecycle publication and event processing.
Runtime status includes an integration summary, and `provider_unavailable` is escalated to attention
and notification through the normal event path. `cli.js` dispatches `source` commands, and the loopback
UI's `/api/sources` plus read-only panel call the fabric status only; they add no control or write.

Bounds: at most 8 registered providers, 5 filesystem roots, 8 health paths, 2,000 files, 8 depth,
100 observations per poll, 50 service observations, 4 KiB event payload, 256 KiB response cap,
2,000 checkpoint files, 500 fingerprints, 20 recent health rows and 10 stored errors. Intervals are
1 s–24 h; timeouts 100 ms–30 s; retries at most 5 with a 1 h base cap. These are validation limits,
not guarantees about an external system.

No inference. No provider has a model handle, model endpoint, model process, embedding, classifier
or background inference. `source diagnose` asserts this explicitly. Testing uses deterministic
providers, temporary roots and a loopback HTTP server; the 30 T-11 scenarios include no construction
polling, stable identity/dedupe/replay, stale/conflicting/out-of-order observations, timeout,
failure/recovery/backoff, bounded batches, checkpoint and restart recovery, isolation, permissions,
secret exclusion/redaction, malicious payload refusal, runtime pause/end-to-end flow, CLI/UI reads,
no-inference checks, sustained polling bounds and existing-path regressions.

## T-12 contextual knowledge and content understanding (as implemented)

`src/documents/` adds a second, separately permissioned data plane beside T-11 metadata observation.
It owns the content configuration, document version log and deterministic retrieval; it does not add
a second knowledge store, event pipeline, action registry or model path. `DocumentService` is
constructed once in `app.js` with the existing knowledge, situational, world-model and goal stores,
and is passed to the controller, loopback UI and `ExecutiveRuntime`.

| Module | Responsibility | Authority | Failure behaviour |
| --- | --- | --- | --- |
| `vocabulary.js` | Schema, `filesystem.content.read`, default formats, closed limits, extractor identity | Vocabulary only | Out-of-range values are validation errors |
| `store.js` | Checksummed atomic `documents.json`, append-only `documents.jsonl`, writer lock, current-document derivation | Own files only | Corrupt lines are counted; configuration checksum mismatch is refused |
| `service.js` | Authorized scan/read, extraction, versioning, candidate creation, search/ask/evidence/compare/context, T-09 events | Calls `KnowledgeStore.addSourceCandidate` and `situation.ingest` only; no action or execution | Per-file read/extract failures are contained; one failed item does not hide completed versions |
| `cli.js` | `document` lifecycle, ingest, read, retrieval and promotion commands | User-origin commands only | Usage errors exit 2; refused/skipped operations exit 1 |
| `../filesystem/documents.js` | Existing bounded PDF/DOCX/XLSX/CSV/text parsers plus BOM-aware decoding | Pure local parsing | Malformed or oversized input is refused at the extractor boundary |

`DocumentService` reads `documents.json` lazily. Construction, status, list and search read the
index but never scan or read a source file. `configure` validates absolute, non-root directories,
extension and exclusion bounds, and writes configuration without granting the content permission.
`enable` is the explicit grant; `disable` preserves history; `pause` stops the runtime tick from
reading while leaving manual configuration readable. `ingest` is the only content-read entry point.
It scans roots with `readdir({ withFileTypes: true })`, skips symlinks, sensitive segments/files and
excluded names before stat/read, and enforces file count, size, depth and extraction caps. A
truncated scan suppresses deletion detection.

Each accepted file gets a stable `doc:` identity from the authorized root label and relative path.
A SHA-256 content hash selects duplicate versus new version; records retain source path, root label,
format, bytes, observed/ingested times, extractor id/version, text hash, permission scope, sections,
limitations and warnings. PDF/DOCX/XLSX extraction is delegated to the existing parser; text/CSV is
decoded with BOM handling. The index log also records deletion and invalidation events, so current
documents are derived rather than rewritten. A deleted or invalidated document can be indexed again
with a new version while older versions remain readable.

Extraction candidates are narrow deterministic observations: key/value lines, top-level JSON scalar
fields and CSV rows. They are stored through `KnowledgeStore.addSourceCandidate`, never through
`knowledge.add`. That method accepts no caller origin or update mode; it validates the document
reference, enforces the same text/secret bounds, records `source_extracted` provenance with
`{documentId,path,version,contentHash,section,locator}`, and returns candidates in `status:
"uncertain"`. `promoteSourceCandidate` requires the existing user-origin authorization, appends a
normal user claim and a retraction of the candidate. The candidate is not mutated, so its document
evidence remains auditable. The prompt knowledge selector excludes source candidates; the world
projection excludes them from user/model belief counts while conflict groups can still show a
candidate disagreement.

Retrieval is deterministic: tokenisation with the existing stop-word set, optional quoted exact
phrase, term counts, current-version filtering, document prefix, version and section filters, and
bounded excerpts with section range. `contextFor` returns at most the caller's character budget and
labels each line with document id, version and section. The controller adds this as an untrusted
source-data section with an explicit system instruction; it never treats document text as an
instruction, goal, approval or authorization. `ask` returns four separate channels: explicit source
excerpts, deterministic extraction, the documented retrieval rule, and unknown/missing terms. A
version-comparison question uses the deterministic line diff. No citation is created without a
matching excerpt.

T-09 events use `source: "external_provider"`, stable `sourceEventId =
doc:<documentId>:v<version>[:deleted]`, types `document_indexed`, `document_updated`,
`document_extraction_failed` and `document_deleted`, reporter `documents`, provider
`filesystem_content`, a bounded excerpt and document metadata. Existing T-09 validation,
duplicate/replay handling, significance, world-model application and T-10 notification rules apply
unchanged. Existing goals whose request/title/description share tokens with the document path or
first 2,000 characters are linked in `goalRefs` and `payload.affectedGoals`; the service never
changes a goal or starts an action. `ExecutiveRuntime` calls `documents.ingestDue()` during its
bounded tick and includes the document summary in status; extraction failures are in the existing
attention type set.

Bounds: 5 roots, 40 extensions, 20 exclusions, 500 files per scan, 4 MiB per file, 8 directory
levels, 200,000 extracted characters, 200 sections, 20 candidate facts per version, 500 retained
documents, 20 query results, 20,000 context characters (caller may lower it) and 1 s–24 h intervals.
No document service has a model handle, endpoint, embedding, vector index, OCR engine or network
client. The 34 T-12 tests use temporary roots and real extractors; no test starts inference.

## T-13 unified cognitive reasoning and evidence engine (as implemented)

`src/reasoning/` composes existing capabilities into one deterministic session. It owns a bounded
evidence projection, the reasoning rules and the append-only session log. It does not own or copy
memory, knowledge, documents, world state, situations, goals, plans, tasks, predictions or
operations, and it adds no model path.

| Module | Responsibility | Authority | Failure behaviour |
| --- | --- | --- | --- |
| `vocabulary.js` | Schema, trust/relation/time/conclusion/decision vocabulary, closed bounds | Vocabulary only | Out-of-range or unknown values are rejected by callers/stores |
| `evidence.js` | Normalize cross-store evidence, trust and relation mapping, document/external/candidate entries, cross-document conflicts, dedupe/digest | Pure projection; source records remain authoritative | Unreadable evidence remains a limitation; claims are bounded and stripped of control characters |
| `engine.js` | Evidence assessment, T-02 hypothesis normalization, temporal analysis, conclusion classification, decision construction, trace | Pure rules over supplied records | Every class states the rule; no probability, utility score or authorization |
| `dependencies.js` | Plan-step dependency graph, missing prerequisites, cycle detection, downstream propagation, explicit causal links | Reads plans/tasks/world relationships only | Cycles and missing nodes are reported, not traversed indefinitely |
| `store.js` | Append-only `reasoning.jsonl`, bounded sessions, invalidation events, recovery | Own file only; user-origin invalidation | Corrupt lines are counted; a full bounded history refuses a new session rather than growing without limit |
| `service.js` | Bounded cross-subsystem retrieval, document/observation enrichment, session assembly, replay/compare | Reads the existing services; writes only its own session | Per-source failures become stated limitations; one unavailable source does not invent an empty world |
| `present.js`, `cli.js`, controller methods | Bounded presentation, user commands and direct controller methods | User origin only; not registry actions, not plannable and never model-origin | Usage errors exit 2; a refused read or write does not claim success; `reasoning.jsonl` is the durable trace |

Retrieval starts with the existing `analyzeRequest` pipeline so objective understanding, memory,
knowledge, experience, predictions, goals/plans/tasks, world conflicts, T-02 hypotheses, assumptions
and unknowns are reused rather than reimplemented. It then adds authorized document search (current
and prior version), document candidate facts, cross-document field conflicts, and situational
observations that match the request tokens. Knowledge history is supplemented with a bounded read so
a superseded or retracted record can be shown as historical even though current search excludes it.
Every item is deduplicated by stable evidence id and ordered deterministically.

The evidence item carries `evidenceId`, source and source record id, bounded claim, provenance,
observed/recorded/valid times, validity, `current`, trust, relation, locator, contradictions,
retrieval reason and an untrusted-content flag. `user_instruction` is contextual. Documents and
external observations are marked untrusted content. Cross-document conflicts are derived evidence
citing the competing candidate records; they are not a new source fact. Source excerpts remain in
their authority stores; the session keeps only the bounded display excerpt and reference.

Assessment counts supporting, contradicting, contextual, historical, candidate and total items; it
groups explicit contradictions and derived cross-document conflicts. It records independent settling
support, unavailable sources, missing classes and unsupported claims. A T-02 reading is retained as a
reading, with its qualitative support level and any evidence it cited. Candidate sides of a document
conflict become separate unresolved hypotheses. Preference is only recorded when no conflict exists
and exactly one reading has direct, uncontradicted support, or when T-02's own rule selected one.

Dependency analysis maps each plan step to `step:<planId>:<stepId>`, reads `dependsOn` and
`stepResults`, marks `completed`/`skipped` prerequisites as satisfied, reports missing node
references, detects cycles with a bounded DFS, and propagates each blocked node to at most 12
downstream nodes. Causal edges exist only for explicit causal predicates in active world
relationships. Temporal analysis orders by observation time, not recorded time; it reports
`recordedLater` separately, classifies validity windows, retains prior document versions and flags
blocked/cancelled/failed plans rather than treating them as current.

Conclusions are generated by closed rules: conflict first; then two or more independent current
settling records (`strongly_supported`); then one (`directly_supported`); then only non-settling,
candidate or historical support (`tentative`); then an explicit unsupported claim (`unsupported`);
otherwise `unknown`. Missing information is listed. Decision options use recorded goal criteria,
blocked prerequisites, evidence conflicts, historical state and exact plan reversibility. Irreversible
work is surfaced (`irreversible`/`not_reversible`), but options are never executable and cannot
bypass the controller, approvals or action authorization.

The append-only session stores the request, evidence references and digest, assessment, hypotheses,
dependencies, temporal view, conclusion, decision, trace, assumptions, unknowns and authorization
note. Store validation enforces the schema, id, bounds, allowed relations, trace length and
`authorizes:false`. `replay` and `compare` run with `persist:false`; they never append a duplicate
session and they report a changed evidence digest or conclusion instead of presenting an old result
as current. `invalidate` is a separate user-origin event and leaves the original session readable.
`ExecutiveRuntime` includes reasoning status but does not start a session or execute a recommendation
during its tick.

Authorization and trust boundaries are unchanged. Reasoning actions are user-origin and
non-plannable; there is no model-origin reasoning action. Document and observation text is data, not
instructions. Candidate facts cannot silently become confirmed knowledge. A conclusion cannot grant
permission, approve a plan, or run a task. Every reasoning command is wrapped by the existing
controller operation audit, and the session store is separate from that audit log.

Bounds are 40 evidence references, 8 per source, 6 hypotheses, 12 evidence ids per hypothesis, 120
dependency nodes, 12 traversal depth, 24 trace steps, 200 sessions, 2,000 request characters and
500-character evidence claims. Retrieval and ordering are deterministic. The cross-document conflict
rule is limited to extracted `field:` candidates, and hypothesis evaluation is qualitative. There is no
semantic entailment, calibrated probability, utility maximization, OCR, embedding index or model
call. `benchmarks/run-reasoning-benchmark.mjs` measures normalization, deduplication, assessment,
hypothesis construction and the dependency graph over synthetic sizes without a socket or an
inference process; its figures describe these algorithms only. The 20 T-13 blocks exercise the 34
required scenarios and the additional failure cases described in the README; they use temporary
stores, real document extraction and no inference process.

## T-14: whole-system integration, reliability and operational validation

T-14 changed no architecture boundary. It validated the assembled application, repaired one
integration defect, and added a composition of existing reads so operational state is inspectable
in one place. Every fixture was synthetic, every backend was `NoBackend` or a stub, and no model,
remote or local, was contacted.

### Composition, not a new subsystem

`health.js` is the only new module. It owns no store, action, lock, or authority. Its input is the
set of reads each subsystem already exposes; its output is one bounded record with ten areas, each
naming its `source`. The CLI `health` command and the UI `GET /api/health` call the same function,
and the UI renders it with `textContent` in a read-only panel.

| Concern | Where it lives | What T-14 established |
| --- | --- | --- |
| Composition | `health.js` (`collectHealth`) | Ten areas composed from `collectDiagnostics`, `runtime.status()`, `situation.status()`, `integrations.status()`, `documents.status()`, `reasoning.status()`, `worldModel.status()`, `learning.status()`, and derived storage |
| Severity | `SEVERITY` in `health.js` | `failed` > `blocked` > `degraded` > `unknown` > `healthy`; overall is the worst non-advisory area plus attention items |
| Advisory model | `advisory:true` without `--model` | A configured but unprobed model is `unknown` and cannot decide a local install's result |
| CLI | `cli.js` `health` | Exit 0 only when overall is `healthy`; `--json` prints the record; `--model` adds a model-list probe and no inference |
| UI | `ui/server.js`, `ui/assets.js` | Authenticated `GET /api/health`; read-only panel; same view as the CLI |
| Damage | store reads and `collectDiagnostics` | A damaged store is `failed`; a damaged checkpoint is quarantined by the reading store, never deleted |
| Writes | none | Reading health creates no file and appends no audit record |
| Authority | none | `authorizes:false` is not even a field because the view decides nothing; no caller reads it to permit work |

### The repaired integration defect

The document service enforced `LIMITS.maxDocuments` at scan level: when the index held 500 live
identities, the next scan refused every document as a whole. That coupled one new file to the fate
of unchanged and changed indexed files. The repair enforces the bound per document: a new identity
beyond the cap is skipped and reported as `limited` with one warning; a changed indexed identity
still produces a version; an unchanged file is not re-read; and invalidation frees a slot. The
result keeps the index bounded without turning a capacity limit into a scan-wide failure.
`t14-scale-bounds.test.js` pins the four outcomes against a real 500-document store, and the T-12
suites still pass unchanged.

### Acceptance workflows A-G

`t14-workflows.test.js` (8 cases) runs the assembled system, not isolated modules:

| Workflow | What the records must show |
| --- | --- |
| A | A fact survives two restarts; a correction supersedes and preserves the old record; the later deterministic answer follows the correction and cites it |
| B | A dependent goal cannot activate before its prerequisite completes; only the ready plan runs; reasoning reports `authorizes:false` and `executable:false`; completion follows recorded evidence |
| C | Documents stay unread without the separate content permission; disagreeing sources are `CONFLICTING`; a changed document keeps two versions with their own bytes |
| D | An external observation becomes an assessed `recommend`/`request_approval` decision and a notification, creates no task, and is cited by reasoning as `external_observation` |
| E | An interrupted execution leaves an uncertain step, is never replayed, and refuses continuation; after finalization only the unreached step runs, and a second continuation is refused |
| F | A failing provider is isolated while a healthy one still processes; queue and notifications stay bounded; pause/resume/shutdown preserve work; a failed step blocks its plan without re-execution |
| G | Instruction-shaped document text, a forged origin, an unauthorized UI request, and a damaged store are each refused and recorded, not repaired silently |

`t14-reliability.test.js` (2 cases) adds restart durability with no replay and a torn final record
read as damage. `t14-scale-bounds.test.js` (1 case) adds the repaired capacity boundary.

### Boundaries re-checked

The workflows exercised the registry, controller, model trust boundary, UI authentication,
provider permission, document content permission, runtime lifecycle, append-only stores, writer
locks, audit redaction, private-memory exclusion, reasoning and health reads, and recovery. None
widened. In particular: a model or document instruction never reached an action as permission; the
UI's cookie, same-origin check, `x-apex-ui` header, and loopback bind held; an observation created
no task; a continuation took up only a step the records prove never started; and a damaged file was
preserved. A refused crossing is written to the operations log.

### Measured scale

`benchmarks/run-t14-scale-benchmark.mjs` (outside `npm test`, `APEX_DATA_ISOLATED=1`, `NoBackend`,
51 checks) measured documents at 100 / 1,000 / 5,000 synthetic files and evidence at 100 / 1,000 /
5,000 records. The 1,000- and 5,000-file runs converge because one scan examines at most 500 files
and the index holds at most 500 identities. First ingest at 100 / 500-indexed documents was 12.36 s
/ 111.99 s; unchanged re-ingest 636 ms / 3.33 s; search 11.27 / 20.66 ms. Evidence retrieval was
28.57 / 45.05 / 78.77 ms, a complete request 163.45 / 165.82 / 239.96 ms, and a reasoning session
112.42 / 111.63 / 141.76 ms. Only in-run ratios are findings. The complete table, the situational
emit attribution and its limitation are in
[`README.md`](README.md#t-14-whole-system-integration-reliability-and-operational-validation).

### Limits

- Health observes readable records at one moment. It is not a monitor, not a score, and cannot see
  a live process with stale records.
- A first document ingest re-reads the situational log once per emitted event; the measured cost is
  disclosed and the store was not restructured during validation.
- The index holds at most 500 live identities and one scan examines at most 500 files; a larger
  directory is reported as truncated.
- The scale figures are one machine, one run, and synthetic data; they are not throughput claims.
- No inference is performed or claimed, and no answer-quality or model-behaviour claim is made.
