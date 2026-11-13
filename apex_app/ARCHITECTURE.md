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
which the controller invokes; the cognitive runtime validates the reply afterward.

| Component | Module | Responsibility | Input → output | Persistence | Authority | Failure behavior | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Request understanding | `cognition/request.js` | Classify intent, referents, time range, ambiguity, unsupported capability, missing information | Request text + store-derived context → structured understanding | None | None; description only | Ambiguity becomes a clarification before any model call; unsupported capability is named | `cognition-understanding.test.js`, `cognition-scenarios.test.js` D |
| Evidence retrieval | `cognition/evidence.js` | Bounded reads across memory, knowledge, experience, adaptation, temporal summary, prediction, World Model, goals/plans/tasks, conversation, request | Stores → one evidence shape per record, with source, validity, status, relationships; omissions counted | None | None | A source that was read and empty, unavailable, or damaged is kept distinct; absence is not negative proof | `cognition-reasoning.test.js`, `cognition-evidence-states.test.js` |
| Claim extraction and contradiction map | `cognition/claims.js` | Extract claims, classify kinds, reduce duplicates, keep both sides of a disagreement | Evidence → claims + contradiction map | None | None | Both sides retained; no recency/source-rank resolution | `cognition-lineage.test.js`, `cognition-evidence-states.test.js`, `cognition-scenarios.test.js` B |
| Deliberation | `cognition/deliberation.js` | Thirteen ordered deterministic steps from question to decision and disclosures | Claims + contradictions + uncertainty → deliberation result | None | None | A decision is `answer`, `clarify`, `abstain`, `refuse`, or `recommend`; no step executes | `cognition-reasoning.test.js`, `cognition-scenarios.test.js` |
| Grounded response construction | `cognition/response.js` | Build the bounded grounding brief, validate structured responses and plain answers, phrase disclosures, correct model action claims | Analysis → brief + validation result + disclosure text | None | None | A citation the model did not retrieve, a forged state, or an over-certain structure is rejected whole | `cognition-reasoning.test.js`, `cognition-evidence-states.test.js` |
| Model protocol | `cognition/protocol.js` | Extract, bound, parse, and reject the optional `COGNITION` line | Model text → parsed structure or refusal | None | None | Malformed, oversized, non-object, duplicate, or unknown-kind structures are rejected whole | `cognition-contract.test.js`, `proposal-boundary-an.test.js` |
| Model gateway | `model/gateway.js` | Replaceable backend; classifies every reply and records provenance | Request → `valid`/`empty`/`refused`/`unavailable`/`malformed`/`context_limit`/`cancelled` reply | None | None | Cancellation is distinct from timeout; only `UNREACHABLE`/`INTERRUPTED` retry; refusal/empty/malformed never retried into a different outcome | `gateway.test.js`, `gateway-resilience.test.js`, `runtime-states.test.js` |
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
| Plan validation | `plans/validity.js`, `plans/model.js` | Validate live registry, dependencies, goal revision, evidence, constraints, approval binding | Controller on activation; registry on each step | `plans.jsonl` | A stale approval, missing action, failed dependency, or unreadable constraint refuses activation | `plan-constraints.test.js`, `plan-continuation.test.js`, `plan-adversarial.test.js` |
| User approval and hash binding | `plans/model.js`, `executive/preview.js`, `actions/plan-actions.js` | Approval is a user-origin event bound to plan version + content hash; preview prints what is approved | User only | `plans.jsonl` (`plan.approval`) | A revision clears approval; an approval from another version/hash cannot activate new bytes | `handoff-hash-binding-ao.test.js`, `executive-acceptance.test.js` K-04, K-22 |
| Authorization | `actions/registry.js` | Every action declares permission (`read`/`write`) and origins; write actions are user-only; a model-origin write cannot be registered | Action registry | None (policy in code) | Unknown action/origin denied; denied step executes nothing | `model-self-authorization.test.js`, `proposal-boundary-an.test.js`, `capability-inventory.test.js` |
| Executive handoff | `executive/handoff.js`, `executive/mapping.js` | Record each crossing as one bounded handoff: model proposal, plan activation, or task run; ids, hashes, recorded outcomes | None; every handoff says `authorizes:false` | Attached to the operation record | Invalid construct or stale reference fails closed; no request/input/model text | `handoff-integrity-ao.test.js`, `handoff-hash-binding-ao.test.js`, `executive-bridge.test.js` |
| TaskRunner | `controller/task-runner.js`, `tasks/model.js`, `tasks/store.js` | Run each step through the controller's existing action path; own task/step transitions; record one `task.step` operation per executed step | Task creation (user) or task approval (user, for model-proposed tasks); registry per step | `tasks.jsonl` under the task lock | A failed step stops dependants; an interrupted step is uncertain, never success; no replay | `tasks.test.js`, `task-lifecycle.test.js`, `executive-acceptance.test.js` K-13–K-18 |
| Execution | `actions/executor.js`, `actions/builtin.js`, `actions/*-actions.js` | Validate input and run the action body; report what happened only | Registry already allowed it | The action's own store | Validation error → `input_rejected`; body throws → execution failed; no verification claimed | `actions.test.js`, `failure-semantics.test.js` |
| Independent verification | `verify/verifier.js` | A different component re-reads the store or recomputes the value and decides the postcondition | None; it reports only | None | Verifier unavailable/failed → not success; independent of executor | `executive-acceptance.test.js`, `executive-bridge.test.js`, `integration-runtime-an.test.js` |
| Finalization and audit | `controller/finalization.js`, `operations/operation-log.js` | One completion contract for every path: audit append, experience capture, completion; masking and minimization at the write boundary | Operation log's single append path | `operations.jsonl` | Audit append failure downgrades success and reports `recorded:false`; never invents experience | `finalization-contract.test.js`, `finalization-interruption.test.js`, `append-audit-failure-semantics.test.js` |
| Continuation and recovery | `plans/continuation.js`, `continuation/engine.js`, `executive/recovery.js`, `tasks/lock-recovery.js` | Read nine states from plan/task/audit records; take up only steps proven never to have started; refuse to replay an uncertain effect | User initiates continuation; no background recovery | Reads only; the resulting step runs through the normal path | A refused or unsafe continuation executes and writes nothing; a second continuation takes up nothing | `plan-continuation.test.js` (real children), `continuation-cross-process-an.test.js`, `executive-readiness.test.js` |
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
  modification time - the stores' content validation and hashes remain the authority there.
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
  evidence store or index.
- **Bounded reads disclose clipping.** `adaptation.effectiveness` reads one adaptation past its
  20-row window and reports `integrity.truncated` with `truncatedSources: ['adaptations']` when the
  extra row exists, so a full store and a captured window no longer look identical. The state becomes
  `valid_bounded`; the totals still report 20 read.

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

### Cognitive evaluation

`cognition/evaluation.js` runs fixed synthetic scenarios in memory over the deterministic pipeline.
Nine dimensions (`request_interpretation`, `evidence_retrieval`, `contradiction_detection`,
`claim_grounding`, `clarification`, `abstention`, `response_consistency`, `proposal_validity`,
`lifecycle_correctness`) and four defect classes (`false_support`, `missed_contradiction`,
`unsupported_claim`, `inappropriate_proposal`). There is no composite score. The harness writes
nothing and does not call a model. It has no executive-handoff scenario; handoff has its own suites.

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

Known scaling behavior: memory and knowledge searches are linear in the number of records; JSONL
cold reads parse the whole store; the AM index removes the repeated learning read, not the initial
one. No quadratic path is claimed or known in the request path. Unmeasured: real-model latency and
quality, stores beyond the fixtures used, multi-user or network filesystems, and long-running
operation logs.

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
7. `stark/` is separate research; `apex_app/` does not import it. No neural–cognitive bridge exists.

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
| Adversarial acceptance | `IMPLEMENTED_AND_TESTED` | Cross-cutting; no new runtime component | `acceptance-ao09.test.js` (7), `adversarial-batch-am.test.js` (16), `plan-adversarial.test.js` (15), `executive-adversarial.test.js` (11), plus the suites cited in `README.md` Batch AO package H |
| Cross-process interruption | `IMPLEMENTED_PARTIALLY_TESTED` | Real child fixtures at most boundaries | `plan-continuation.test.js`, `continuation-cross-process-an.test.js`, `finalization-interruption.test.js`, `process-recovery.test.js`, `cross-process-ao09.test.js`; two boundaries lack a killed child |
| Concurrent store integrity | `IMPLEMENTED_AND_TESTED` | `memory/writer-lock.js`, store locks, JSONL append | `storage-concurrency.test.js`, `store-write-concurrency.test.js`, `cross-process-stress.test.js`, `lock-contention.test.js`, `lock-recovery.test.js` |
| World Model (append-only records, read-time reduction) | `IMPLEMENTED_AND_TESTED` | `world/store.js`, `world/model.js`, `world/query.js` | `world-model-core.test.js`, `world-model-scenarios.test.js` |
| Prediction ledger | `IMPLEMENTED_AND_TESTED` | `prediction/*`, `actions/prediction-actions.js` | `prediction-*.test.js` (6 suites) |
| Temporal experience | `IMPLEMENTED_AND_TESTED` | `experience/temporal.js`, `experience-store.js` | `experience-temporal*.test.js` |
| Model gateway protocol (stub) | `IMPLEMENTED_AND_TESTED` | `model/gateway.js` | `gateway.test.js`, `model-workflow.test.js`; no test runs a real model |
| Real-model answer quality | `DESCRIPTIVE_ONLY` | — | One dated observation (2026-10-31); no automated evidence |
| Neural integration | `NOT_IMPLEMENTED` | Boundary document only | Nothing to run |
| General planner, persistent learning, voice, UI | `NOT_IMPLEMENTED` | — | Scope statements only |
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
cannot see a same-size, same-mtime rewrite; the request path's retrieval, world-state and prediction
readers remain per-store atomic and do not claim otherwise.

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
node benchmarks/run-cognitive-runtime-benchmark.mjs
node benchmarks/run-adaptation-decision-benchmark.mjs
node benchmarks/run-prediction-adaptation-benchmark.mjs
node benchmarks/run-longitudinal-benchmark.mjs
node benchmarks/run-effectiveness-benchmark.mjs
node benchmarks/run-governance-benchmark.mjs
APEX_DATA_ISOLATED=1 node benchmarks/run-evidence-benchmark.mjs
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
