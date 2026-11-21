# T-30 Progress Report

**Report checkpoint:** Packages 0–6 complete to their bounded scope, 2026-11-19 (UTC).
Browser/visual evidence is unavailable in this environment and is marked UNVERIFIED throughout.

> **Step-series checkpoint (2026-11-19, later the same day).** Four further steps were requested and
> completed on this branch: **S1** `/api/state` latency, **S2** the T-29 unified cognitive pipeline,
> **S3** the zero-dependency thin desktop shell, and **S4** full verification. They are recorded in
> the "Step series S1–S4" section at the end of this report; the Package 0–6 sections above are kept
> as written and are not restated. **S1 was corrected after its first commit:** the fast path it
> shipped keyed on filesystem metadata that this machine's filesystem does not change on a
> same-length rewrite, so it could serve stale records. The full suite caught it, the mechanism was
> replaced with digest-verified retention, and the correction is written up in the S1 subsection.

**Scope:** T-30 Packages 0–6.

> **Superseded statement (2026-11-19, same day).** The previous checkpoint read "Packages 0–4
> only. Packages 5–6 were intentionally not started." The owner then requested the P0 client
> fix, real-browser re-verification, Package 5 and Package 6 on the same branch. That earlier
> scope line is kept here as history and is no longer the current scope.

## Repository checkpoint

- Starting commit: `fb09e73f2d875fe8697d731c9b9845dd054a0465`.
- Package 0 code commit: `45ae99a87645be444070741d6cdea1e31c45f352` (`T-30 P0: repair syntax, inventory, and storage integrity`).
- Package 1 code commit: `875e3bc46703179ab50bcd22aa71c96939574f03` (`T-30 P1: define Core state ownership and precedence`).
- Package 2 code commit: `ba08127` (`T-30 P2: version owner events and reconcile streams`).
- Package 3 code commit: `fa9f8f9` (`T-30 P3: integrate live Core state and safety controls`); full verification is recorded below.
- Package 4 code commits: `d3b0936` (`T-30 P4: implement owner-backed workspaces with truthful states`), `3c753c2` (`T-30 P4: finish workspace empty-state and document-count truthfulness`) and `1ce7bf4` (`T-30 P4: show Resource Fabric diagnostics in the system workspace`); the P4 full suite ran on `1ce7bf4` and this report is committed afterwards as `d8b1880` plus this correction. Verification is recorded below.
- HEAD at the Package 0 code checkpoint: `45ae99a87645be444070741d6cdea1e31c45f352`; later checkpoints are recorded below.
- Active branch: `arena/c4691a2f-a-p-e-x`; `origin/main` was fetched and remained at the starting commit. At the Package 0 checkpoint no branch switch, push, PR, tag or history rewrite had been performed; the later checkpoints pushed this branch and opened PR #5 (`T-30: complete Packages 0–4 for APEX`, base `main`).
- `stark/` and the unrelated OnCall Memory project were not modified.
- Package 0 tests ran against the working tree that was committed unchanged as `45ae99a`.

## Package status

| Package | Status | Notes |
|---|---|---|
| 0 — Syntax, inventory, data-directory failures, storage, CI | **Complete and verified** | Full suite passed at the P0 checkpoint; see exact results below. |
| 1 — Ledgers, architecture, requirements, numbering, state precedence/ownership | **Complete and verified** | Added dated ledger/requirements/architecture annotations and the ten-state source/precedence contract. Focused UI/core-state tests passed (26/26), syntax passed, and the P1 checkpoint full suite passed (3,733 total, 3,731 passed, 0 failed, 2 skipped); commit `875e3bc46703179ab50bcd22aa71c96939574f03`. |
| 2 — Authoritative state events and cross-process observation | **Complete and verified** | Bounded versioned owner snapshots, cross-process refresh, replay/reconciliation, heartbeat/watchdog handling and preservation of transient events. Package-focused tests pass (36/36); syntax passes across 223 source files. Full Core-state integration was not claimed at the P2 checkpoint; its later P3 completion is recorded below. |
| 3 — T-18 UI defects and lockdown integration | **Complete and verified** | All seven authoritative owner snapshots feed the live Core projection with full precedence and fail-closed validation; truthful boot/Quick boot, request-thinking, state visuals, and ECP safety UI are covered. Safety routes require local UI auth/CSRF, enforce the action's 240-character reason limit and release confirmation, return audit evidence, and do not resume paused runtime work. Focused tests 44/44; full suite passes (3,751 total, 3,749 passed, 0 failed, 2 skipped); syntax and diff checks pass. Browser execution remains unverified. |
| 4 — Truthful owner-backed workspaces | **Complete and verified** | Mission Control, Approval Centre, Sentinel, Memory Timeline, Conversation and the recorded Briefing are projections of the owning stores, including goals, plans, tasks, approvals, situational events, memory, knowledge and world-model history. Each workspace reports loading, empty, error, partial and unavailable states; provenance and lifecycle history are preserved, and writes stay on the existing controller paths. Focused tests 83/83 and 101/101; syntax passes; the P4 checkpoint full suite passed (see below). Browser execution remains unverified. |
| 5 — Experience system and desktop readiness | **Complete to its bounded scope; browser rendering unverified** | Design tokens from master §4.1 as shipped values, five owner-selectable presentation modes plus a latch-derived Lockdown presentation, reduced-motion and high-contrast support, `:focus-visible`, keyboard view traversal, five responsive breakpoints, and removal of the last dead element reference (`#situation`). Desktop shell ADR written (`reports/T30_P5_DESKTOP_SHELL_ADR.md`). Focused tests 10/10. Layout, pixels, overflow and perceived motion remain UNVERIFIED: no browser can be installed here (see `T30_P0_BROWSER_VERIFICATION.md` §4). |
| 6 — Whole-system validation and evidence | **Complete to its bounded scope; browser evidence unavailable** | `node --check` on 225 source files; full suite **3,781 tests, 3,779 passed, 0 failed, 0 cancelled, 2 skipped, 582 suites** (22m47s); real timings measured for state read, event delivery, degraded detection and reconnect reconciliation. Playwright could not launch a browser (6 of 7 tests cannot start; no binary), so screenshots at 1600×900, 1280×720 and 390×844 are **not produced**. Recorded below and in `T30_P0_BROWSER_VERIFICATION.md`. |

## Package 0 work completed

- Repaired the nested template literals in `src/ui/assets.js` and literal `\n` escape sequences in `src/app.js`.
- Added `tests/source-syntax.test.js` and `npm run test:syntax`. It runs `node --check` on every JavaScript source file (**221 files**) and parses the extracted `UI_CLIENT` independently.
- Aligned the live capability inventory, README and capture classification: current counts are 139 default actions, 154 with a configured workspace root, 84 read actions and 70 write actions. Prior counts are identified as historical. Workshop reads are included in the read-only store snapshot, `workshop.compose` is covered by the model-origin write-denial sweep, and inventory tests exercise seeded Workshop data.
- Corrected fail-closed expectations for unusable data directories, exposed session diagnostics detail, and validated Workshop candidates before append.
- Fixed the reproduced concurrent JSONL append defects. Appends now use the cross-process writer-lock protocol unless the authoritative store lock already owns the same path; that ownership is propagated through `AsyncLocalStorage`, including `TaskStore`'s manual lock. Readers wait briefly and re-read an unterminated tail only while a writer lock is present. Fault-injection tests now target the data file rather than the lock's staging file.
- Changed Linux resident-memory sampling to read the live process's `/proc/<pid>/status` entry instead of spawning `ps` for every sample. The pilot failure assertion now includes the report output when a scenario exits nonzero.
- Updated CI to trigger on every push to `main`, install development dependencies with `npm ci --ignore-scripts`, run the source/UI syntax guard and the full suite, and allow 35 minutes for the observed suite runtime.

## Files changed in Package 0

- `.github/workflows/apex-app-tests.yml`
- `apex_app/README.md`
- `apex_app/package.json`
- `apex_app/pilot/harness.js`
- `apex_app/src/app.js`
- `apex_app/src/diagnostics.js`
- `apex_app/src/memory/jsonl-store.js`
- `apex_app/src/memory/writer-lock.js`
- `apex_app/src/tasks/store.js`
- `apex_app/src/ui/assets.js`
- `apex_app/src/workshop/store.js`
- `apex_app/tests/capability-inventory.test.js`
- `apex_app/tests/cli-workflow.test.js`
- `apex_app/tests/controller.test.js`
- `apex_app/tests/failure-semantics.test.js`
- `apex_app/tests/model-self-authorization.test.js`
- `apex_app/tests/source-syntax.test.js` (new)
- `apex_app/tests/storage-concurrency.test.js`
- `apex_app/tests/t16-pilot-reporting.test.js`

## Package 1 completed — dated reconciliation and Core-state contract

- Preserved and annotated the earlier T-19 Core table instead of deleting it. Added a current ten-state source/owner/precedence table and a state-ownership register in `apex_app/ARCHITECTURE_V2.md`. The fixed order is **Lockdown > Degraded > Awaiting Approval > Uncertain > Executing > Thinking > Idle**. Dormant, Listening and Speaking have no live source and are reserved/not reachable; persisted task uncertainty is a real source, so it is reachable. The UI setter fails safely to Degraded for reserved or unknown values.
- At the Package 1 checkpoint, added `src/ui/core-state.js` with state definitions, reachability, precedence, `resolveCoreState()` and explicit source/owner descriptions. The pure resolver was contract code at that checkpoint; the UI did **not yet consume every source or apply the full precedence**. Package 3's later live integration is recorded below.
- Corrected the basic UI state key to `awaiting_approval`; the served client embeds the same state definitions and refuses reserved/unknown Core state assignments. This does not grant UI authority or alter ECP policy.
- Annotated stale T-16/T-17 claims in `docs/APEX_V2_REQUIREMENTS.md` about no ECP, no L0–L5 configuration, no kill switch, no Resource Fabric owner, and no briefing/Council/Workshop foundation. Each addendum distinguishes the local foundation from the complete v2 target and preserves the original statement as historical.
- Added dated reconciliation notes to `ARCHITECTURE.md`, `APEX_MISSION_PROGRESS.md`, `T19_PROGRESS.md` and `T24_IMPLEMENTATION_REPORT.md`. The earlier failed-fetch statement is retained as an observation from the older Windows checkout; `git fetch origin` succeeded in this Arena checkout.
- Numbering resolution: no milestone IDs were invented. T-19 is the separate `T19_PROGRESS.md` checkpoint; T-20–T-24 are summarized in `T24_IMPLEMENTATION_REPORT.md`; T-25, T-26/T-27 and T-28 appear in the later progress ledger/Master Project Document; T-29 remains **not accepted as a unified integration milestone**. This clone is shallow and does not contain the historical commit objects, so those earlier claims were not independently replayed or backdated as verified.

### Files changed in Package 1

- `APEX_MISSION_PROGRESS.md`
- `T19_PROGRESS.md`
- `T24_IMPLEMENTATION_REPORT.md`
- `apex_app/ARCHITECTURE.md`
- `apex_app/ARCHITECTURE_V2.md`
- `apex_app/docs/APEX_V2_REQUIREMENTS.md`
- `apex_app/src/ui/assets.js`
- `apex_app/src/ui/core-state.js` (new)
- `apex_app/tests/core-state-contract.test.js` (new)
- `apex_app/reports/T30_PROGRESS.md`

## Package 2 completed — bounded authoritative owner events and reconciliation

- Added `src/ui/event-contract.js` with `apex.state-event/1` and `apex.event-heartbeat/1`, strict stream/sequence/owner-version validation, a bounded replay history, the subscriber frame-queue guard and an injectable 1.5 s watchdog helper.
- The UI server now emits bounded owner snapshots for tasks, plans, approvals, ECP lockdown, runtime, health and conversation. Owner versions increase only when that owner's projection changes; every state event has a process-specific stream ID and contiguous sequence. The client rejects gaps, duplicates, out-of-order versions, malformed envelopes and stream mismatches, then requests explicit reconciliation when needed.
- A directory watcher plus a 250 ms metadata-poll fallback observes data changes made by other CLI processes. Reconnects replay retained events from `Last-Event-ID`; changed stream IDs or unavailable history produce a full owner reconciliation. History is capped at 128 state events, streams at eight subscribers, each event frame at 256 KiB and the response queue at 1 MiB.
- Preserved the separate progress/chat/Council/Workshop events. Heartbeats are emitted every 500 ms with the server head sequence; the browser watchdog expires at 1.5 s and marks transport state Degraded. At the Package 2 checkpoint this was not the full Core-state precedence integration; Package 3's later completion is recorded below.

### Files changed in Package 2

- `apex_app/src/ui/event-contract.js` (new)
- `apex_app/src/ui/server.js`
- `apex_app/src/ui/assets.js`
- `apex_app/tests/ui-event-contract.test.js` (new)
- `apex_app/tests/ui-owner-events.test.js` (new)
- `apex_app/tests/ui-server.test.js`
- `apex_app/reports/T30_PROGRESS.md`

## Package 3 completed — live Core projection, T-18 UI, and ECP safety controls

- Connected all seven Package 2 owner snapshots (`tasks`, `plans`, `approval`, `lockdown`, `runtime`, `health`, `conversation`) to `resolveCoreStateFromOwners()` and the served client. Both initial reconciliation snapshots and contiguous owner updates feed the same reducer; chat Thinking is derived only from a real outstanding `/api/chat` request.
- The live order is **Lockdown > Degraded > Awaiting Approval > Uncertain > Executing > Thinking > Idle**. Missing/malformed task counts, approval arrays, ECP flags, runtime lifecycle/pause state, health projection/counters, conversation counts, stale reads, or event liveness fail closed to Degraded. A positively observed active latch still wins. Health attention that is solely the same recorded approval or uncertain outcome is represented by that more-specific Core state; unrelated health blockers remain Degraded. Paused tasks or runtime scheduling are not presented as healthy Idle. Dormant, Listening and Speaking remain reserved.
- T-18 UI corrections: the page boots in Degraded until authoritative reconciliation; boot diagnostics read actual state, health, ECP latch and event reconciliation rather than displaying a fictitious loopback check; both Quick boot controls skip the overlay; Core status has reachable-state visuals, an uncertainty treatment, Idle breathing, steady Degraded, contracted red Lockdown, reduced-motion handling and a screen-reader status; chat requests present Thinking only while pending.
- Added the System safety panel and kept mutations on the existing Controller/ECP action path. The local UI token, POST marker and same-origin guard protect the controls. Lockdown/release reasons obey the underlying action's 240-character limit; release additionally requires a non-empty reason and explicit checkbox/`confirm: true`. Responses surface audit operation IDs and `recorded`; malformed/failed audit attempts are not presented as confirmed. Latch state is marked stale during a mutation and refreshed before release is re-enabled. ECP remains the authority, and releasing the latch does **not** resume a paused runtime or task.
- Owner/event/served-client, malformed-source, real startup Idle, real external CLI draft Awaiting Approval, and real uncertain-task projection are covered by the focused tests. Safety integration covers missing/wrong authentication, CSRF marker, reason length, release confirmation, audit fields/origin/reason and no-auto-resume.
- Local UI-token authentication is not owner identity/MFA/step-up. Playwright/browser interaction and screenshots remain unverified because Chromium is unavailable; full v2 cinematic visuals are not claimed.

### Package 3 files changed

- `apex_app/src/ui/assets.js`
- `apex_app/src/ui/core-state.js`
- `apex_app/src/ui/event-contract.js`
- `apex_app/src/ui/server.js`
- `apex_app/tests/ui-core-projection.test.js` (new)
- `apex_app/tests/ui-owner-events.test.js`
- `apex_app/tests/ui-server.test.js`
- `apex_app/ARCHITECTURE.md`
- `apex_app/ARCHITECTURE_V2.md`
- `apex_app/docs/APEX_V2_REQUIREMENTS.md`
- `apex_app/reports/T30_PROGRESS.md`

## Package 4 completed — truthful owner-backed workspaces

- Added owner-backed projections and routes: `GET /api/mission-control` (GoalStore, PlanStore, TaskStore), `GET /api/approvals` (TaskStore, PlanStore and situational approval requests), `GET /api/timeline?limit=N` (MemoryStore, KnowledgeStore, WorldModelStore), an expanded `GET /api/situation`, and an expanded `GET /api/briefing`. Each answers with a per-source `available` flag, an error string when a source could not be read, and a `status` of `available`, `partial` or `unavailable`.
- Added bounded chronological projections `KnowledgeStore.timeline()` and `WorldModelStore.timeline()` (1–100 rows). The combined timeline merges memory records with knowledge claims/retractions/resolutions and world-model changes in recorded-time order and reports `partial` when any owner is unreadable or memory reports corrupt records.
- Goal projections now carry origin, criteria with basis/requirement, blockers, unknowns, contradictions, completion records, entity/world references and bounded status/revision history. Plan projections carry origin, risk, approval binding, activation task, preconditions, checkpoints with recorded progress, linked outcomes and bounded lifecycle history. Task and approval projections carry the recorded origin/planner and the task's goal/plan references.
- Situation decisions bind to a recorded assessment and never execute an action. The page exposes only `ignore`, `record`, `investigate`, `notify` and `recommend` through `POST /api/situation/decide`, which calls `controller.situationDecide`. Approved execution remains a separate CLI `situation execute` step.
- Writes stay on the existing user-origin controller methods: task approve (`POST /api/tasks/:id/approve`), plan approve, plan cancel (`POST /api/plans/:id/cancel`, reason 1–500 characters, unknown fields refused) and the situational decision above. Approving a record changes intent only; no page control starts a task, runs a plan, resumes a paused runtime or executes a situational response.
- The served client's `refresh()` cycle now reads these endpoints instead of the older list routes, and every workspace has its own status element with `data-state` styling for `available`/`empty`/`partial`/`error`/`unavailable`/`loading`. Unavailable owners are named, an unavailable count is `null` rather than zero, and the briefing says so in its own note.
- System diagnostics now shows the health areas, runtime status, external sources and Resource Fabric readings. CPU and memory come from the fabric; GPU and network are shown as unavailable with the provider's own reason, so an absent provider is never displayed as a zero reading. The existing ECP safety controls and their audit evidence are unchanged.
- No decorative controls and no fabricated records were added. Controls appear only where an owner recorded a pending request or a cancellable plan, and the cancellation form states that cancelling a plan does not stop a task created from it.
- README records the workspace/route table and replaces the stale claim that the page has no situational write path with a dated addendum.

### Package 4 files changed

- `apex_app/src/ui/server.js`
- `apex_app/src/ui/assets.js`
- `apex_app/src/knowledge/knowledge-store.js`
- `apex_app/src/world/store.js`
- `apex_app/src/briefing/index.js`
- `apex_app/tests/ui-server.test.js`
- `apex_app/README.md`
- `apex_app/reports/T30_PROGRESS.md`

### T-19–T-29 evidence crosswalk

| Milestone | What the retained records say | T-30 treatment |
|---|---|---|
| T-19 | Separate checkpoint; it reports UI/Core/event work and refers to `e9d0880` and `301ba97`. | Kept as history; commit objects are absent from this shallow clone. Package 2 independently verified the current bounded event implementation and does not retroactively verify those historical commits. |
| T-20–T-24 | `T24_IMPLEMENTATION_REPORT.md` summarizes Command Experience, planner/TaskGraph, briefing, evolution foundation and documentation. | Summary retained; its starting commit `5098705` is unavailable locally and historical tests are not retroactively rerun. |
| T-25 | Council and served UI foundation; historical report records 8 Council tests and 7 Playwright tests. | Node tests are included in the P0/P1/P3 full-suite runs; Package 2 preserves served events. Browser run here is blocked by missing Chromium; historical screenshots are not newly reviewed. |
| T-26/T-27 | Workshop design-composition/store/actions/UI foundation. | Current Node suite passes; P0 repaired the nested UI template syntax. The product remains a deterministic design/simulation tool, not 3D CAD or code execution. |
| T-28 | Local device-trust registry foundation. | Its tests are included in the passing full suite; transport, Presence Mesh, owner MFA and UI/ECP device operations remain unimplemented or unverified. |
| T-29 | Ledger says “not started”; current repository also contains separate cognitive/executive modules. | Still not accepted as a unified integration milestone; module presence and a green suite are not proof of the complete pipeline. |

## Verification evidence

| Command | Result |
|---|---|
| `node --test tests/briefing.test.js tests/memory-knowledge-history.test.js tests/world-model-core.test.js tests/t09-situational-awareness.test.js tests/ui-server.test.js` (P4 focused run) | **101 tests: 101 passed, 0 failed, 0 skipped**; covers the owner timelines, briefing owners, situational state and the new workspace routes. |
| `node --test tests/ui-server.test.js tests/ui-core-projection.test.js tests/ui-owner-events.test.js tests/core-state-contract.test.js tests/briefing.test.js tests/t12-documents.test.js` (P4 focused runs) | **83 tests: 83 passed, 0 failed, 0 skipped**; includes the served-client checks, the document-index route change and the Resource Fabric diagnostics. |
| `npm run test:syntax` (P4 final run) | **1 passed, 0 failed, 0 skipped**; every JavaScript source file and the served client parsed. |
| `npm test` (P4 final full suite) | **3,760 tests: 3,758 passed, 0 failed, 0 cancelled, 2 skipped; 577 suites**. Runtime 1,307,566 ms (about 21m48s). Log: `/tmp/apex-t30-p4-final.log`. Code checkpoint `1ce7bf4`; this report is committed separately afterwards. |
| `npm run test:syntax` (P0 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked 221 source files and separately parsed the served client. |
| `npm run test:syntax` (P1 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked 222 source files and separately parsed the served client. |
| `node --test tests/cross-process-stress.test.js tests/storage-concurrency.test.js tests/t16-pilot-reporting.test.js` | **21 tests: 21 passed, 0 failed, 0 skipped**. |
| `node --test tests/core-state-contract.test.js tests/ui-server.test.js` (P1 checkpoint) | **26 tests: 26 passed, 0 failed, 0 skipped**; covers all ten state rows, precedence, reserved-state rejection and UI-server integration. |
| `node --test tests/core-state-contract.test.js tests/ui-event-contract.test.js tests/ui-owner-events.test.js tests/ui-server.test.js` (P2 checkpoint) | **36 tests: 36 passed, 0 failed, 0 skipped**; adds event-envelope/version/gap checks, bounded replay/queue guards, cross-process CLI plan/runtime changes, stale-stream reconciliation, fail-closed health/lockdown owner events, subscriber limit and preserved progress/chat events. |
| `npm run test:syntax` (P2 checkpoint) | **1 passed, 0 failed, 0 skipped**; checked all 223 JavaScript source files and parsed the served client independently. |
| `node --test tests/core-state-contract.test.js tests/ui-core-projection.test.js tests/ui-event-contract.test.js tests/ui-owner-events.test.js tests/ui-server.test.js` (P3 final focused run) | **44 tests: 44 passed, 0 failed, 0 skipped**; includes real startup Idle, external CLI draft Awaiting Approval, real uncertain-task projection, malformed sources, precedence, UI safety gating, ECP auth/audit and no-auto-resume. |
| `npm run test:syntax` (P3 final run) | **1 passed, 0 failed, 0 skipped**; all 223 JavaScript source files and the served client parsed. |
| `npm test` (P3 final full suite) | **3,751 tests: 3,749 passed, 0 failed, 0 cancelled, 2 skipped; 576 suites**. Runtime 1,302,751 ms (about 21m43s). Log: `/tmp/apex-t30-p3-final.log`. |
| `npm test` (P0 checkpoint) | **3,729 tests: 3,727 passed, 0 failed, 0 cancelled, 2 skipped; 570 suites**. Runtime 1,245,229 ms (about 20m45s). Log: `/tmp/apex-p0-full-verified.log`. |
| `npm test` (P1 checkpoint) | **3,733 tests: 3,731 passed, 0 failed, 0 cancelled, 2 skipped; 571 suites**. Runtime 1,231,611 ms (about 20m32s). Log: `/tmp/apex-p1-full.log`. |
| Full `npm test` immediately after Package 2 | Not run at the P2 checkpoint; the later P3 final full suite covers the combined P0–P3 working tree. |
| `git diff --check` (P3 final review) | Passed. |
| `npm run test:e2e` | Could not launch because the installed `node_modules/.bin/playwright` shim is not executable in this workspace (`Permission denied`). |
| `node node_modules/@playwright/test/cli.js test` | **7 tests discovered: 1 passed, 6 could not launch Chromium** because Playwright's `chrome-headless-shell` binary is absent. No system Chromium/Chrome/Firefox was present. This is an environment/browser-availability blocker, not six observed product assertion failures. Browser verification and screenshots remain **unverified**. |

The P4 final `npm test` passed across the combined P0–P4 application code, served-client and documentation changes on code checkpoint `1ce7bf4`. Like the P3 run, it says nothing about browser behaviour; the Playwright blocker below still applies.

The P3 final `npm test` passed across the combined P0–P3 application code and architecture/requirements changes. The progress report was then updated with that result; the exact full-suite total and log are shown above. This does not retroactively convert the P2 checkpoint's focused-only run into a P2-only full-suite claim. Playwright was attempted through the package CLI; browser-based validation could not execute without a browser binary. No browser download was attempted. No `npm ci` was run locally; the existing development installation was used.

## Package 5 work completed (experience system and desktop readiness)

- **Tokens.** `UI_CSS` now carries the master-document values as the canonical tokens
  (`--bg-void #05080f`, `--bg-deep #0a1220`, `--glass rgba(12,28,48,0.55)`, `--arc-cyan #00e5ff`,
  `--armor-gold #ffb000`, `--armor-red #e10600`, `--ok-green #2bff88`, `--text #dcebff`,
  `--text-dim #7fa3c7`, `--radius 2px`) with aliases (`--cyan`, `--gold`, `--muted`, `--panel`,
  …) so no pre-existing rule changed meaning silently. Tabular numerals are applied to the body
  and to every numeric readout. `--armor-red-text #ff6b5a` exists because `#e10600` measures
  below 4.5:1 on the void background; the raw red stays a fill/border colour.
- **Modes.** Classic is the default skin; Tactical, Overwatch, Synthesis and Quiet are
  token-only overlays (palette emphasis, one motion-duration change each) selected from a real
  `<select>`; Lockdown is **derived from the ECP latch** through the Core projection and disables
  the selector while active. No mode rule hides a record surface, and no mode reaches an API,
  a store or the ECP — asserted by test.
- **Accessibility.** `:focus-visible` outline on every interactive element, `aria-current="page"`
  on the active nav item, `aria-pressed` on the motion/contrast toggles, a skip link, a labelled
  mode selector, `prefers-reduced-motion` and a manual reduced-motion switch, `prefers-contrast:
  more` plus a high-contrast toggle, and measured contrast ≥ 4.5:1 for seven text/surface token
  pairs (the test computes the ratio from the shipped hex values).
- **Responsiveness.** Breakpoints at 1600, 1280, 1100, 720 and 480 px, `min-width: 0` and
  `overflow-wrap` on panels/rails/stages, and horizontal scrolling confined to `<pre>` blocks.
  The layout itself is unverified without a browser.
- **Dead controls.** A new audit found `getElementById('situation')` registered but absent from
  the served page and never read; it was removed. The audit now fails the suite if any
  `getElementById` target is missing, if a nav item has no view section (or vice versa), or if a
  voice/microphone/push-to-talk control appears.
- **Desktop shell ADR.** `reports/T30_P5_DESKTOP_SHELL_ADR.md` evaluates loopback browser +
  thin shell, Tauri and Electron across IPC security, lifecycle, authentication, window
  management, startup/shutdown, local data access, packaging/updates, crash recovery, resource
  usage and security boundaries. Recommendation: thin shell now, Tauri if a native shell becomes
  necessary, Electron rejected. No shell code was written.

### Package 5 files changed

- `apex_app/src/ui/assets.js` (tokens, modes, focus/contrast/motion rules, responsive breakpoints,
  mode and preference controls, keyboard traversal, latch-derived Lockdown presentation)
- `apex_app/tests/ui-experience-system.test.js` (new, 10 tests)
- `apex_app/reports/T30_P5_DESKTOP_SHELL_ADR.md` (new)
- `apex_app/reports/T30_PROGRESS.md` (this report)

### Package 5 verification

| Check | Result |
|---|---|
| `node --check` on every file under `apex_app/src` | **225 files, 0 failures** |
| `node --test tests/ui-experience-system.test.js` | **10 tests, 10 passed, 0 failed** |
| `node --test` on the nine UI/syntax suites | **71 tests, 71 passed, 0 failed** (18 suites, 13.7 s) |
| Real-browser verification of modes, focus, overflow, screenshots | **UNVERIFIED** — no browser can be installed (see `T30_P0_BROWSER_VERIFICATION.md` §4) |

## P0 client fix and Step 2 verification (recorded here for completeness)

- **Defect.** The served client embedded Node functions with `.toString()`; the first event threw
  `ReferenceError: STREAM_ID_RE is not defined` and the Core stayed on Degraded against a healthy
  server. Reproduced against `d7ad87e` with the new test (4 of 5 cases fail with that exact error).
- **Fix (commit `3cb33ea`).** One self-contained factory (`src/ui/client-contract.js`) is called by
  Node and rendered verbatim into the browser; `core-state-tables.js` holds the vocabulary as
  data; `core-state.js` and `event-contract.js` keep their public exports.
- **Guards.** `ui-client-contract-source` (bare-vm execution and Node/browser equivalence),
  `ui-client-runtime` (shipped script, fake stream, 1500 ms watchdog measured), and
  `ui-live-stream` (real server, real SSE, real cross-process write, real restart).
- **Step 2 (commit `0798d4b`).** `reports/T30_P0_BROWSER_VERIFICATION.md` records every failed
  route to a Chromium binary (blocked CDN, missing shared libraries, no apt access, unreachable
  release assets). No screenshot was produced and none is claimed.

## Package 6 work (whole-system validation)

See the evidence table and the measured timings below. Screenshots at 1600×900, 1280×720 and
390×844 are **not available** in this environment; nothing in `reports/` was generated by this
session, and the historical `t25_*.png` captures were not re-verified.

## Package 6 evidence (whole-system validation)

Command context: Linux, Node 22.22.3, `apex_app/`, working tree at commit
`T-30 P6` (this commit's parent `763456d` plus the two test-text updates in this commit).

| Check | Exact result |
|---|---|
| `node --check` on every file under `apex_app/src` | **225 files, 0 failures** |
| `npm run test:syntax` | **1 passed, 0 failed** |
| `node --test` (full suite) | **3,781 tests, 3,779 passed, 0 failed, 0 cancelled, 2 skipped, 582 suites**; 1,366,890 ms (22m47s); log `/tmp/apex-t30-p6-final.log` with `EXIT=0` |
| `node node_modules/@playwright/test/cli.js test` | **7 discovered: 1 passed, 6 failed to launch** — `browserType.launch: Executable doesn't exist at /home/user/.cache/ms-playwright/chromium_headless_shell-1255/chrome-headless-shell-linux64/chrome-headless-shell`. These are environment failures, not product assertions. |
| `npx playwright install chromium` | Failed: `ECONNRESET` to `cdn.playwright.dev:443` (see `T30_P0_BROWSER_VERIFICATION.md` §4 for the five other attempted routes) |
| `git diff --check` | Clean |

### Measured timings (real, from `tests/ui-live-stream.test.js`; not a browser)

The harness runs the shipped `UI_CLIENT` in a `vm` against a real `createUiServer` on loopback,
with a real `text/event-stream`, real timers and a real cross-process `plan add`.

| Measurement | Value | Notes |
|---|---|---|
| First `/api/state` read | **167–204 ms** | cold start of the app in the harness; includes store reads |
| First reconcile frame after page load | **225–281 ms** | server sends the reconciliation immediately on connect |
| Heartbeats received | **2 in 1.2 s** | server cadence 500 ms |
| Degraded detection when the server stops | **20 ms** | the transport errors immediately, which also marks the stream degraded |
| Degraded detection when heartbeats stop but the socket stays open | **1,500 ms** measured on a virtual clock | the watchdog value; acceptance limit 2,000 ms (`tests/ui-client-runtime.test.js`) |
| Reconnect-to-reconciled after a restart on the same port | **338 ms** | includes the client's 300 ms reconnect backoff |
| Cross-process write visible as Awaiting Approval | under 2 s | a real `plan add` in a separate process |

These are harness numbers on this machine. They are **not** browser paint timings, first-contentful
paint, or layout measurements.

### Screenshots

**None produced.** `apex_app/reports/` contains no image from this session. The `t25_*.png` files are
historical Windows captures and were not re-verified. The three required viewports (1600×900,
1280×720, 390×844), the workspace, approval, lockdown and degraded views therefore have **no visual
evidence**, and the responsive claims in Package 5 are supported only by static CSS assertions.

## Risks and blockers

- Browser behavior and screenshots are not verified in this environment because there is no installed browser executable. Keep this explicitly marked unverified unless browser execution becomes available.
  - *Updated 2026-11-19 (Package 6):* the blocker is now characterised precisely rather than as "no
    installed browser". Playwright's browser download fails with `ECONNRESET` at
    `cdn.playwright.dev:443`; no system browser or Electron is installed; ten Chromium shared
    libraries (`libnss3`, `libnspr4`, `libgbm`, `libatk-1.0`, `libxkbcommon`, `libasound`, `libcups`,
    `libdrm`, `libpango`, `libcairo`) are absent; `apt` cannot be used (no permission, no mirror); and
    a portable Chromium release asset is unreachable (`curl` 35). See
    `reports/T30_P0_BROWSER_VERIFICATION.md` §4.
- P0 resolves the observed concurrent-write and pilot-reporting failures; it does not establish broader cross-platform filesystem guarantees beyond the passing tests on this Linux/Node 22 environment.
- No inference, model download, model endpoint, voice/audio path, or remote inference process was used or added.

## Current blockers and limits

- Browser rendering, end-to-end clicks and screenshots remain **unverified**: the Playwright shim is non-executable and Chromium/Chrome/Firefox binaries are absent. The served client parses and Node UI/server tests pass, but neither establishes browser behavior.
- The UI token is process-local authentication, not owner identity, MFA or step-up authentication. The ECP remains the authorization authority.
- The full v2 visual/cinematic target and Listening/Speaking/audio remain unimplemented, and Packages 5–6 are outside the completed T-30 scope. No completion claim is made for them.
- T-19 historical commit objects remain unavailable in this shallow local history; current T-30 tests do not retroactively verify historical evidence.
- P0's passing storage tests do not establish broader cross-platform filesystem guarantees beyond this Linux/Node 22 environment. No inference, model download, endpoint, voice/audio path, or remote inference process was used or added.

## Step series S1–S4 (2026-11-19, after the Packages 0–6 checkpoint)

Four steps were requested in a fixed order, each verified and committed before the next. Every
number below was measured in this environment; nothing visual was observed.

### S1 — `/api/state` latency (commit `d1c9155`; mechanism corrected by the S4 repair)

**Defect.** The Package 6 pilot measured 167–204 ms for `/api/state` against a Part 4 bound of
≤150 ms. Profiling showed the cost was not one pathological read: the page-load burst issues
fifteen owner routes, and each one that read a store re-read, hashed and re-parsed the whole file
even when nothing had changed. Paired measurement on this machine before any change: a cold
`/api/state` racing fourteen other owner routes took **155.2 ms**, and the full fan-out
**174.3 ms**.

**Change, final form.** `src/memory/jsonl-store.js` retains, per instance, the records it last
derived together with the SHA-256 of the exact bytes they were derived from. `load()` reads the
file, hashes it, and serves the retained records only when digest **and** byte length both match.
Anything else — a different digest, a different length, an unterminated tail, a missing or
unreadable file, more than `readCacheMaxRecords` records, or more bytes than the store's
`parseCacheBytes` cap — falls through to the unchanged parse path. The bytes are therefore always
read; what retention saves is the parse, the validation and the freeze, plus the per-route
repetition inside one burst, because concurrent reads of one file share a single in-flight read.
A read certifies its digest to a caller (the knowledge lifecycle index) only when this store kept
the derivation, so an uncertified read still authorizes nothing.

**Correction, same day: the first version keyed on file identity and was wrong.** `d1c9155` keyed
the fast path on `fs.stat({ bigint: true })` — `dev/ino/size/mtimeNs/ctimeNs` — on the assumption
that a rewrite in place moves `mtimeNs`/`ctimeNs`. On this machine's scratch filesystem
(ext2/ext3) it does not: a 28-byte file rewritten with 28 different bytes reported **identical**
`ino`, `size`, `mtimeNs = 1795158626995990272n` and `ctimeNs` afterwards. The first full-suite run
found it — `tests/request-scoped-reads.test.js` returned `aaaa` where `bbbb` had been written — and
it was then reproduced directly against the filesystem, so it was a cache-correctness bug, not a
flaky test. The identity key was removed rather than patched: no store in APEX now reuses records
on the strength of metadata this filesystem does not promise. Hashing a file that was just read
costs a fraction of parsing and validating it, and the bound below is kept without the unsafe key.
An earlier draft of this section claimed the identity path was safe *because* an in-place rewrite
moves `mtimeNs`/`ctimeNs`; that claim was false here and is withdrawn.

**Measured — paired A/B, same harness, same machine, back-to-back.** The pre-S1 file
(`d1c9155^`) and the current file were swapped in turn; seven full runs each; seeded with 300
memory records / 150 tasks / 60 plans / 30 goals, page = `/api/state` plus the fourteen other owner
routes.

| Measurement | Before (`d1c9155^`) | After (content-verified) |
|---|---|---|
| cold `/api/state`, single read | 40.3 ms (36.9–59.1) | 40.6 ms (37.3–59.9) |
| cold page fan-out, 15 routes | **182.2 ms** (139.6–203.6) | **125.4 ms** (102.5–241.3) |
| warm `/api/state` p50 | 12.7 ms | 12.6 ms |
| warm page fan-out p50 | 70.2 ms (62.5–85.2) | 53.5 ms (50.8–66.3) |

Contended run (200 tasks / 100 memory; `/api/state` racing fourteen routes; five rounds; state and
page in ms):

| Round | Before: state / page | After: state / page |
|---|---|---|
| 0 (cold) | **155.2 / 174.3** | **87.9 / 98.5** |
| 1–4 (warm) | 37.5–87.7 / 46.3–101.2 | 31.5–50.4 / 39.9–56.9 |

Read these numbers for what they are. `/api/state`'s own cost is dominated by the causal projection,
not by store parsing, so its single-read cold and warm figures barely move; the gain is in the
burst, where the repeated whole-file parses used to sit. This box has two vCPUs and single cold
samples are noisy: the mid-suite sample reached 241 ms while a 24-minute test run was finishing,
and the medians with min–max are reported instead of one sample. The acceptance bound is asserted
on `/api/state` itself — ≤150 ms cold, ≤100 ms warm, single read and under a concurrent burst,
plus a cross-process write visible on the very next read — and `tests/ui-state-latency.test.js`
measures those directly.

**Test.** `tests/ui-state-latency.test.js` (5 tests, 5/5): a cold read ≤150 ms, every warm read
≤100 ms with retained reads actually served (`readCacheStats.hits > 0`), a page-load burst that
does not push `/api/state` past 150 ms, an external `plan add` visible on the very next read with a
proved retained-read miss, a lockdown latch flipped by another process visible at once, and a
damaged `kill-switch.json` reported `policyUnavailable: true` and never `active: false`. The
regression that caught the identity bug is
`tests/request-scoped-reads.test.js` ("a same-length rewrite is parsed again, not answered from the
snapshot"); `tests/knowledge-lifecycle-reuse.test.js`, `tests/retrieval-snapshot.test.js`,
`tests/incremental-write-state.test.js`, `tests/store-write-concurrency.test.js` and
`tests/storage-integrity.test.js` pin the rest of the store's reuse contract.

### S2 — T-29 unified cognitive pipeline (commit `49651dd`)

`src/cognition/pipeline.js` runs one owner intent through five recorded stages and stores the run
in `cognition-runs.jsonl` (append-only, same store rules as every other ledger).

1. **Context** — a `CognitiveContextPacket` of owner goals, memory records, knowledge claims and
   world-model facts. Every claim carries an epistemic tag (`observed | inferred | assumed |
   predicted`) decided by fixed rules over the record's own provenance and confidence, and every
   cited item names its record id.
2. **Salience** — read-only `urgency`, `confidence`, `uncertainty`, `goal_progress`,
   `resource_pressure` (Resource Fabric), `risk_sensitivity`, `novelty`, each with a stated basis.
   `goal_progress` is `null` rather than invented when no goal reports criteria. Sentinel
   advisories are carried as advisories; they cannot authorize anything.
3. **Council** — the deterministic Council's perspectives, mapped to `thesis`, `counter_risk` and
   `evidence_check` and cited against the packet, with the recommendation and the explicit
   `authorizesExecution: false`. Skipped, with the reason, when uncertainty and risk are low.
4. **Task graph** — one step per concrete action, carrying the registry's permission and risk.
5. **Execution** — through the controller, registry and ECP only.

**The gate.** A write, an L2+ action, a high/critical-risk action, an irreversible effect or a
security-relevant capability stops the run before anything executes: the task is recorded, taken to
its authorization gate, and left `paused` with the step in `awaiting_approval`. Only
`controller.approveTask(taskId, { stepId })` records the owner's approval; `runTask(id, 'resume')`
then executes it. `verified: true` is derived from the task step's `success_verified` outcome on
every read, never from the pipeline's own claim.

**Fail-closed.** An active latch or an unreadable latch halts the run with
`KILL_SWITCH_ACTIVE` / `POLICY_UNAVAILABLE` before a task exists; an ECP denial of the concrete
action halts with the ECP's reason. The capability itself (`cognition.run`) is owner-only, write,
unplannable, and denied to a model origin, so under lockdown the ECP refuses it and the requesting
operation records the denial.

**Surface.** `POST /api/cognition/run`, `GET /api/cognition/runs`, `GET /api/cognition/runs/:id`,
`POST /api/cognition/runs/:id/approve`, a `cognition` SSE event, and a Command Deck workspace that
renders the five stages from the run record with an approval control only when the run says a step
is waiting.

**Two representation defects found while wiring it, and fixed.**

- `src/health.js` counted a paused task awaiting approval **twice** (once as `approval`, once as an
  unexplained `paused-task`), which made the Core report Degraded for a gated run.
- `src/ui/client-contract.js` treated *any* paused task as degradation, so `Awaiting Approval` was
  unreachable for a paused task even when a step was waiting. A paused task with nothing waiting
  still degrades the Core; a pending approval now outranks the bare paused-task warning.

**Tests.** `tests/cognition-pipeline.test.js` 15/15 (packet, salience bounds and basis, Council
perspectives, read end-to-end verified, write gated → approve → resume → verified, lockdown halt
with an audit record, unreadable latch, unregistered capability, registry classification, storage
and corruption handling, the health double-count). `tests/ui-cognition.test.js` 8/8 (all four
routes, refusal and 404 cases, the SSE transition, and the shipped `UI_CLIENT` rendering five
stages, offering the approval control, and re-reading on the event — in a vm, not a browser).

### S3 — zero-dependency thin desktop shell (commit `ab630fa`)

Option (A) of `reports/T30_P5_DESKTOP_SHELL_ADR.md`, implemented as `src/ui/desktop-shell.js`.

- Starts the existing loopback UI server on `127.0.0.1` and a free or configured port
  (`--port`, `APEX_DESKTOP_PORT`, `APEX_UI_PORT`, else kernel-assigned), then **verifies
  `/api/state`** answers with the process token before it launches anything.
- Resolves a Chromium-family executable: an explicit setting first (`APEX_DESKTOP_BROWSER_BIN`, or
  `--browser` naming one binary for this run), then discovery in the order `msedge`, then
  Chrome/Chromium per platform. It launches it with `--app=<loopback url>`,
  `--user-data-dir=<dataDir>/desktop-profile` (mode 0700), `--no-first-run` and
  `--no-default-browser-check`. Arguments are passed as a vector; nothing is interpolated into a
  shell.
- `--dry-run` and `--print-launch-spec` return the exact command without spawning; the spawner is
  injectable, so every behaviour is tested on a machine with no browser.
- With no browser installed it prints an honest diagnostic, starts nothing, and leaves the working
  URL on screen. It never pretends a window exists.
- Stops the server and terminates the child on exit, `SIGINT` and `SIGTERM`.
- Entry points: `node src/cli.js desktop`, `node bin/apex.js desktop`, `npm run desktop`.

**Correction, found by CI (2026-11-19).** The first version tried `APEX_DESKTOP_BROWSER_BIN` *last*,
so on a machine with a browser installed the setting was silently ignored: the hosted runner has
`/usr/bin/microsoft-edge`, and `--print-launch-spec` reported Edge where the configured binary had
been named. The configured browser is now tried first and discovery answers only when nothing was
configured; `--browser` still replaces the list entirely. `tests/desktop-shell.test.js` gained a
regression that resolves a configured binary against an installed `microsoft-edge` and expects the
configured one. This is also why the first CI runs of S1–S3 were red while the same tree was green
here: this box has no browser at all, so the ordering defect was invisible.

**Tests.** `tests/desktop-shell.test.js` 14/14: explicit-then-discovered candidate order (and the
installed-browser regression above), resolution with the tried list, PATH lookup, launch-spec
construction, port parsing, a real loopback server with a verified ready state and an isolated
profile, dry-run spawning nothing, real spawn argument vectors, the no-binary fallback with a
still-serving URL, idempotent stop, and three CLI runs (`--dry-run`, `--print-launch-spec` JSON,
no-browser fallback).

**Not verified.** No window was opened, and nothing was run on Windows or macOS. The platform
matrices are unit-tested, not executed.

### S4 — full verification

| Check | Result |
|---|---|
| `node --check` over every `apex_app/src/**/*.js` | **228 files, 0 failures** |
| `npm test` (full suite) | **3,823 tests: 3,821 pass, 0 fail, 2 skipped** — two consecutive runs, 1,441.6 s and 1,458.5 s |
| `/api/state`, cold (single read) | 8–14 ms on the live harness's small store; 37–60 ms on the seeded 300/150/60/30 workspace |
| `/api/state`, warm p50 | 8–13 ms small store; 12.6 ms seeded workspace |
| First reconcile frame after page load | 266–384 ms |
| Degraded detection after the server stops | 20 ms |
| Reconnect → reconciled | 331–356 ms (includes the client's 300 ms backoff) |
| Five-stage trace rendered after the `cognition` event | 103–159 ms |
| Core transitions observed through the served client | `idle → awaiting_approval → idle` around one gated run |
| Hosted CI (`.github/workflows/apex-app-tests.yml`, Node 22, ubuntu-latest) | **green** on commit `7a059a3`: same full suite, same syntax guard |

The live harness (`tests/ui-live-stream.test.js`) drives the shipped `UI_CLIENT` inside a vm against
a real `createUiServer`: it records the state reads, the first reconcile frame, the heartbeat
cadence, the T-29 SSE transition, the gated run's approval, the five-stage render and the degraded
and reconnect behaviour. It is **not a browser**: no pixels, layout or motion were observed.

The reconcile, degraded, reconnect and trace rows are the numbers `tests/ui-live-stream.test.js`
prints in its own diagnostics (`--test-reporter=tap`, four consecutive runs on this two-vCPU box;
the range is the spread across those runs). The `/api/state` rows are the live harness's small empty
store (8–14 ms) beside the seeded 300/150/60/30 benchmark workspace used in S1 (37–60 ms cold,
12.6 ms warm p50, seven runs). None of these is a paint, layout or first-contentful-paint
measurement.

The hosted CI job is the independent check on the same tree: `npm ci --ignore-scripts`, the syntax
guard, then `npm test`, green on `7a059a3`. It is also what found the desktop-shell ordering defect
recorded in S3 — the runner has a browser installed and this sandbox does not.

The full-suite row is two consecutive runs that closed this step series, both taken **after** the
S1 mechanism was replaced: 3,823 tests, 3,821 passing, 0 failing, 2 skipped, in 1,441.6 s and
1,458.5 s of wall clock (the second on the committed tree). Two earlier runs are history rather
than results — 3,805/3,823 with 16 failures before the T-29 health, client-projection and inventory
repairs, and 3,820/3,823 with one failure (the same-length rewrite above) before the S1 correction.

**Deliberately not claimed.** Intelligence, executive completeness, in-browser rendering, the three
viewports, screenshots, Windows and macOS behaviour, and any voice path. Passing tests here are
evidence about this code on this machine, not proof of the system's competence.

> **Superseded counts (2026-11-19).** The registry figure in the Package 6 row of the table above
> (and the AF-19 inventory counts) predate T-29: with `cognition.run` registered the verified
> registry is **140 actions by default and 155 with a filesystem root — 85 reads, 71 writes, 56
> plannable**. The earlier 139/154 figures are history, not inventory.


## Next action

The step series S1–S4 is complete: `/api/state` meets its bound on a seeded workspace, T-29 runs
end-to-end behind an explicit owner approval, and the desktop shell launches or honestly reports
that it cannot. What remains is still the evidence this environment cannot produce — a real
Chromium run at the three viewports with zero console errors, plus screenshots — and the owner's
decision on the desktop platform. Until then every visual, layout, overflow, motion and focus
claim stays **UNVERIFIED**.

Packages 0–6 are complete to their bounded scope. The P0 client defect is fixed and guarded, the
experience system is applied, and the desktop-shell decision is recorded. What remains is not a
package: it is the evidence that this environment cannot produce — a real Chromium run at the three
viewports with zero console errors, plus screenshots. Until that exists, every visual, layout,
overflow, motion and focus claim stays **UNVERIFIED**, and passing tests must not be read as proof of
intelligence, of a complete executive system, or of the Tony-Stark experience target.

---

## T-31 Step 2 (2026-11-19): presence, autonomy, the epistemic world model, and the Evolution Lab

Step 1 made the real-browser suite run somewhere a browser exists. Step 2 gives that suite more to
look at, and gives the deck four surfaces it did not have.

**Presence, device trust and autonomy policy.** `GET /api/presence` reads the device-trust service
that already existed (an append-only, hash-chained enrollment log) and returns each device's
identity, trust state, enrollment time and last accepted sequence. It returns **no capability list**,
because a device grants no capability, and the page says so. The mesh itself is *not implemented* in
this build, so the route reports `implemented: false`, an empty peer list and the reason — it does not
invent peers, and the workspace shows one honest row instead of a fabricated topology.
`GET /api/autonomy/matrix` reports the L0–L5 legend from the ECP's own `AUTONOMY_LEVELS` and one row
per registered capability at the level `permissionFor()` actually returns, marking whether the level
came from `APEX_AUTONOMY_LEVELS` or is the registry default (L2 write / L0 read). The route is
read-only and the page states that the UI cannot change it.

**The epistemic world model.** `GET /api/world/epistemic` exposes the projection that the existing
`world.state` action already builds, with the labels spelled out: `user_asserted` renders as "stated
by you — not independently observed" and `unverified_model` as "inferred by a model — unverified".
The renderer's fallback for an unclassified record is `unclassified (never shown as observed)`, so
an assumption cannot be displayed as an observation by omission. A test pins that fallback.

**The Evolution Lab.** The `evolution` state machine existed as pure functions with nowhere to write.
It now has a ledger (`evolution-proposals.jsonl`) and four user-origin capabilities registered like
every other one — `evolution.propose`, `evolution.verify`, `evolution.promote`, `evolution.decide` —
so each act is ECP-authorized, verified and audited. The enforcement is in the lab, not in the page:
a promotion is refused unless a sandbox run recorded a passing result; `verified` must be a boolean
and is stored exactly as reported, so the lab never flips it; a failed result blocks promotion until
a later run passes; only a *requested* promotion can be decided; and an approved promotion cannot be
decided twice. Every refusal is a 400 with the reason. Immutable safety boundaries are returned as
five rows, each one a read of the running system (safety capabilities registered, kill-switch latch,
registry scopes, audit log, and the fact that the ledger is append-only with no path back into code),
and a boundary whose source cannot be read says *could not be confirmed* rather than claiming to be
locked — `evolutionBoundaries({})` returns `allLocked: false`, and a test asserts it.

**Inventory consequence.** Four write capabilities join the registry: **144 actions by default and 159
with a filesystem root — 85 reads, 75 writes**, and they are classified `evolution` in the experience
capture exclusion table with the reason stated. The AF-19 inventory rows and the pinned totals in
`tests/capability-inventory.test.js` were updated in the same commit; the older 140/155/71 figures in
the AF-19 note above are history, not inventory.

**Verified locally, browser-free** (`tests/ui-surfaces.test.js`, 18 tests): the three read routes
against an empty store and against a real enrollment/memory record; the matrix covering every
registered capability exactly once at the level the ECP applies; the full evolution lifecycle over
HTTP including the refusals; ledger persistence across two lab instances; every new DOM id existing in
the served page *and* being read by the served client; the client reading only the routes that exist;
and the audited operation carrying the ECP's `allow` decision and a `success_verified` outcome.

**Not verified here.** Pixels, layout, overflow, focus order and motion remain **UNVERIFIED** on this
machine: it has no Chromium-family binary, so the Playwright suite still reports five skips with the
resolver's diagnostic. The browser assertions added in this step — that `#presence-status`,
`#evolution-status` and `#world-labels` leave their loading state, that the autonomy matrix renders
rows, that every new id exists in the live DOM, and that no fabricated control appears — are executed
by the CI job on a real Edge, and their result is reported by the workflow annotation, not by this
paragraph.

---

## T-31 Step 3 (2026-11-19): step-up, and the correction it forced

**Step-up.** Releasing the lockdown and approving an Evolution Lab promotion are the two acts that
undo a safety control or change what APEX may become, so they now take a third factor when a
deployment configures one. `APEX_STEP_UP_TOKEN` (at least 16 characters, or start-up fails with
`INVALID_CONFIG`) is hashed at construction; the ECP answers `stepUpStatus()` with whether it is
configured and which capabilities it covers, and never with the secret, a digest, or its length.
`verifyStepUp(proof, {capability})` returns `STEP_UP_REQUIRED`, `STEP_UP_REJECTED`,
`STEP_UP_VERIFIED` or `STEP_UP_NOT_APPLICABLE`; the digest comparison is `timingSafeEqual`.

Unset is *off*, not weaker: every existing deployment keeps today's behaviour, and the status says
"not required" in those words. Set, the refusal is fail-closed in both directions — `safety.release`
refuses before it touches the latch (a refused release leaves the kill switch active and writes the
refusal to the audit log), and approving a promotion is refused while a rejection still needs no
proof, because refusing a change is not the consequential act.

The proof is a credential, so it never reaches the audit log: `safety.release` and `evolution.decide`
omit it the same way a note body is omitted, and the record shows `[value omitted: N chars]`. Tests
read the raw `operations.jsonl` and assert the secret and a wrong guess are both absent.

**Release still resumes nothing.** The seed leaves one paused task and one run waiting for the
owner; after lockdown and release the task count is unchanged, the paused task is still paused, and
the run is still `awaiting_approval`. Step-up did not make release a resume button.

**A Step 1 defect, reported rather than quietly patched.** The hosted run for `9d98a80` failed one
test: `desktop shell: the CLI entry point` asserted that emptying `PATH` means no browser is found.
That was true before Step 1 and false after it — the resolver deliberately also checks the absolute
path a distribution installs Edge at, which is exactly why the CI runner can now run a browser. The
test now asks `resolveBrowser()` what this host resolved and asserts the matching branch, so it is
correct on a machine with a browser and on one without; the no-browser message itself stays pinned
by `tests/real-browser-harness.test.js`. The same run showed the browser step reporting
`step=skipped` because the suite failed first, so that step now carries `if: ${{ !cancelled() }}`: a
skip has to mean "no browser", not "an earlier step failed".

**Verified locally** (`tests/step-up.test.js`, 10 tests): the off-by-default path, the
configuration error, the three verification outcomes, both refusals for release with the latch left
active, the successful release, the audit omission, no-resume, the promotion gate (refuse without,
refuse with a wrong proof, reject without, approve with), and the page wiring. **Not verified here:**
the rendering of the hidden field and the note, which the browser suite asserts in CI.

---

## T-31 evidence (2026-11-19): a real browser executed the checks

Run `44736180329` on `f712744` is the first green hosted run in which a **real browser** performed the
verification, and the numbers below are copied from its `real-browser-verification` annotation, not
from a local simulation:

```
step=success | browser=157.0.4341.60 | executable=/usr/bin/microsoft-edge (system)
1600x900: core=Awaiting Approval  overflow 1600<=1600  errors=0
1280x720: core=Awaiting Approval  overflow 1280<=1280  errors=0
 390x844: core=Awaiting Approval  overflow  390<=390   errors=0
reports/screenshots/t31_desktop-wide_1600x900.png 1600x900 328417B
reports/screenshots/t31_desktop_1280x720.png      1280x720 264463B
reports/screenshots/t31_mobile_390x844.png         390x844 103791B
checks: degradedAfterMs=8, connectivityWhileDegraded=Degraded,
        recoveredCore=Awaiting Approval, recoveredConnectivity=Connected,
        modes=[tactical, overwatch, synthesis, quiet, classic],
        modeLockedByLockdown=true, releasedAfterLockdown=true,
        stepUp={hidden:true, note:"No step-up secret is configured…"}
seeded: approvalCount=1, taskStatus=paused, cognitionRunStatus=awaiting_approval
```

A second, independent run on `b320a91` repeated all of it with Edge 157.0.4341.46: zero errors at the
same three viewports, `Degraded` in 23 ms, `Connected` on reconnect, three fresh PNGs (327,201 /
266,352 / 105,716 bytes). Two green real-browser runs from two different Edge builds are the evidence;
one would have been an anecdote.

What this establishes: the deck loads in Edge 157 on a hosted runner with **zero console errors and
zero page errors at all three viewports**, the Core reads `Awaiting Approval` from the seeded gated
run rather than `Idle`, no viewport has horizontal overflow, the stream degrades to `Degraded` within
8 ms of the server stopping and recovers to `Connected` on reconnect, all five presentation modes
switch, Lockdown locks the mode selector and the explicit release restores it, and each screenshot is
a real PNG whose IHDR matches the viewport it was taken at. The presence, autonomy-matrix, Evolution
Lab and step-up surfaces were all reached through the navigation in the same run.

What it still does not establish: motion, focus order, contrast, or that the design looks like the
Tony-Stark target. Three screenshots and three assertions per viewport are not a design review. The
first attempt at this run (`0d098d6`) failed on exactly one console error — the browser asking for a
`/favicon.ico` the page never declared — which is the correction recorded in `f712744`; that same
commit added the four evolution actions to AF-20's model-origin sweep, where the curated attempt list
had fallen out of step with the registry.

## T-32 Step 1 (2026-11-19): the stark HUD reticle, depth planes and a keyboard-first command bar

`f7d47a5` rewrote the deck's visual core in `src/ui/assets.js` (+318 lines, with the preview server in
`bin/apex-serve.js` and one route change in `src/ui/server.js`). The reticle is now five named rings -
`azimuth`, `brackets`, `nucleus`, `progress`, `telemetry` - so a test can name what it is looking at
instead of counting `circle` elements. Depth is four tokens plus the void: `z0` 0, `z1` 10, `z2` 20,
`z3` 30, `z4` 40, each carried on a `[data-depth-plane]` element that is `position: relative`, because
`z-index` on a static box does nothing at all. Motion is four numbers, not adjectives: ack 120 ms,
panel 260 ms, posture 700 ms, reticle 380 ms. The command bar takes `Ctrl+K` and gives focus back on
`Escape`; the tab order puts the command input before the workspace tabs.

Two corrections were forced during this step and are worth keeping. A backticked `/` inside a client
comment closed the template literal that builds `UI_CLIENT` and turned the browser program into
`NaN`, so any edit to that string is checked with `node -e "import('./src/ui/assets.js')..."` before
it is believed. And `body` carries `data-view` as well as the navigation items, which later cost the
T-31 sweep a real failure (Step 4).

## T-32 Step 2 (2026-11-19): the HUD experience suite, run by the real-Edge CI job

`e5e3f4a` added `tests/e2e/t32-hud-experience.spec.mjs` (711 lines) and wired it into the same
hosted browser step that runs T-31, because a HUD that is only described in a report is a claim, not
evidence. The suite drives the real deck in a real system browser and asserts:

- void, glass, critical-panel and depth-plane values are *computed* values at three viewports, not
  the stylesheet's own text;
- the reticle posture differs between Idle, Awaiting Approval, Degraded and Lockdown - colour, ring
  weight, dash pattern and animation each move;
- the live contrast audit: every text run on the page, measured against its computed background;
- keyboard: `Tab` is deterministic and untrapped, the command input precedes the tabs, `Ctrl+K` acks
  within the frame budget, `Escape` returns focus;
- `prefers-reduced-motion` is honoured, and the motion toggle both flips the system preference and
  survives a reload;
- eighteen screenshots - six presentation modes across three viewports - written as real PNGs whose
  IHDR matches the viewport.

The spec writes `reports/screenshots/t32/summary.json` and one `T32_HUD_SUMMARY` line, and the
workflow turns that line into a check annotation, so the numbers are readable without the job log
(which is not downloadable from this runner).

## T-32 Step 3 (2026-11-19): real perception of the host and the workspace

`ec07998` gave APEX senses it did not have. `src/perception/host-workspace-sensor.js` reads the real
host: CPU count and load, memory, storage, uptime, the process's own resident bytes, the git HEAD and
working-tree state of the checkout. `src/perception/push-governor.js` is the discipline that keeps a
sensor from becoming noise - three non-critical pushes per rolling hour, dedupe on watch plus
signature, a critical class (`safety`, `lockdown`, `degraded`) that bypasses the cap, two dismissals
turning into a six-hour revocable suppression, and persistence across restarts.
`src/perception/service.js` holds the observation ledger (`<dataDir>/perception/observations.jsonl`)
and creates nothing until something is written to it.

The capability surface is four governed actions: `perception.sense_host` (write, user-only,
unplannable, verified), `perception.state` (read, user and model), `perception.dismiss_alert` and
`perception.revoke_suppression` (write, user-only, verified). The HTTP surface mirrors them
(`GET /api/perception`, three POSTs, token required, unknown fields refused), `/api/briefing` gains a
`perception` block, and the cognition pipeline folds `packet.host` into `epistemic.observed` so the
model reasons over what the machine actually reported rather than what it assumed.

Two design rules came out of the tests. `unavailable` is not `clean`: a sensor that cannot read a
value must say so, and the governor must not treat silence as health. And a `permission: 'read'`
action that appends to a ledger is misclassified - the ledger write is what makes the capability a
write.

## T-32 Step 4 (2026-11-19): the HUD, measured - and the four defects the browser found

The first hosted run on this branch (`44742231409`) was red, and the second (`44744397430`) was red
for different reasons. Both were useful, because the annotation channel carried the browser's own
words: the job log cannot be downloaded from this runner (`gh api .../jobs/<id>/logs` returns EOF),
so the annotation is the only readback, and a failure that is not in it was not reported.

What the real browser found, in the order it found it:

1. **`[data-view="X"]` matches `<body>`.** The T-31 navigation sweep clicked `.first()` on that
   selector and therefore clicked the page, not the nav item. It passed at 1600x900 and 1280x720
   only because the deck already showed the view it was asked to switch to, and failed at 390x844
   with `toHaveAttribute('data-view', 'deck')` receiving `conversations`. Both suites now name the
   item: `nav .nav-item[data-view="X"]`.
2. **A `calc()`-derived `stroke-width` is not a length.** Chromium reports the substituted
   expression, so the posture test received `"calc(1.8px)"` and `"calc(3.84px)"` and every numeric
   comparison failed. The test now parses the number out of whatever the browser says and asserts
   the four postures differ - which is what the claim was always about.
3. **The diagnostic was the defect.** The HUD summary printed the failing test's message, but the
   message was long enough that the annotation was truncated: the run reported `artifact: 0 PNG(s)`
   without the test that failed to write them. The spec now prints a short `T32_FAILURES` line ahead
   of the long one, the workflow publishes it as its own annotation, each viewport prints a phase
   line as it starts and finishes, and `test.afterEach` records every failure's title, status and
   message into the summary.
4. **Fifteen controls that share a class are fifteen controls.** The Tab sweep keyed each stop on
   `tag#id.class`, so the fifteen nav items collapsed to one key: it counted 10 distinct stops where
   the page has 14 and called that a trap. The key now carries `data-view`.

The narrow-viewport defect from the first red run - a command bar and rows that could not shrink
below their content at 390 px - was fixed in the same pass with `min-width: 0`, `max-width: 100%`
and `overflow-wrap: anywhere` on titles, meta lines and the perception readouts.

### The evidence, from the green hosted run

`44751419073` on `971a043`: every step green, including step 7 (the full Node suite) and step 8
(the real-browser verification), which is the step that matters here.

```
step=success | browser=157.0.4341.46 | executable=/usr/bin/microsoft-edge (system)
1600x900: core=Awaiting Approval overflow=1600<=1600 errors=0
1280x720: core=Awaiting Approval overflow=1280<=1280 errors=0
 390x844: core=Awaiting Approval overflow=390<=390 errors=0
reports/screenshots/t31_desktop-wide_1600x900.png 1600x900 502885B
reports/screenshots/t31_desktop_1280x720.png      1280x720 360815B
reports/screenshots/t31_mobile_390x844.png         390x844 130549B
checks: degradedAfterMs=23, connectivityWhileDegraded=Degraded,
        recoveredCore=Awaiting Approval, recoveredConnectivity=Connected,
        modes=[tactical, overwatch, synthesis, quiet, classic],
        modeLockedByLockdown=true, releasedAfterLockdown=true
```

```
T32_FAILURES {"failures":[],"screenshots":18,"contrastChecked":3940,
              "viewports":["1600x900","1280x720","390x844"]}
hud-step=success | browser=157.0.4341.46
reticle[idle]            stroke=rgb(0, 229, 255)   weight=calc(1.5px)  dash=8px, 6px   animation=spin
reticle[awaiting_approval] stroke=rgb(255, 176, 0) weight=calc(1.8px)  dash=2px, 8px   animation=spin
reticle[degraded]        stroke=rgb(255, 176, 0)   weight=calc(1.2px)  dash=6px, 12px  animation=spin
reticle[lockdown]        stroke=rgb(225, 6, 0)     weight=calc(3.84px) dash=12px, 12px animation=none
planes[desktop-wide]: z0=[0], z1=[10], z2=[20], z3=[30], z4=[40]
planes[desktop]:      z0=[0], z1=[10], z2=[20], z3=[30], z4=[40]
planes[mobile]:       z0=[0], z1=[10], z2=[20], z3=[30], z4=[40]
contrast: 3940 text runs checked, 0 violations
ackMs=6.8 inputBeforeTabs=True
tabStops=a.skip-link > button#command-trigger > select#mode-select > button#motion-toggle >
         button#contrast-toggle > button#new-session > button#quick-boot > textarea#chat-text >
         button#send > button.nav-item[deck] > [conversations] > [missions] > [tasks] > [approvals]
escapeTo=#body
artifact: 18 PNG(s) under apex_app/reports/screenshots/t32
classic/tactical/overwatch/synthesis/quiet/lockdown at 1600x900: 511683/509994/508975/504590/449099/499393B
classic/tactical/overwatch/synthesis/quiet/lockdown at 1280x720: 374318/373610/369492/363166/327460/359736B
classic/tactical/overwatch/synthesis/quiet/lockdown at  390x844: 128527/128863/132979/131495/122016/130777B
```

What this establishes: in a real browser on a hosted runner, the deck has **zero console errors and
no horizontal overflow at 1600x900, 1280x720 and 390x844**; the depth model is four distinct planes
at all three viewports; the reticle's four postures are visually distinct in colour, weight, dash and
animation, with Lockdown the only still one; **3,940 text runs were measured and not one fell below
4.5:1**; the keyboard reaches fourteen stops in a fixed order with the command input before the
workspace tabs, `Ctrl+K` acks in 6.8 ms, `Escape` returns focus to the body, and the reduced-motion
preference plus its toggle both hold; and eighteen screenshots are real PNGs, each within a few
kilobytes of its neighbours, which is what a changing design looks like and a stuck one does not.

A first green attempt (`44749474825` on `c43b3cc`) had already passed both suites; its job was red
only because the publish step referenced a variable it had not yet bound. That is recorded rather
than hidden, because "the tests passed and the job went red" is exactly the case that teaches a
person to stop reading the job.

### Totals

| Run | Tree | Result |
|---|---|---|
| Baseline, before T-32 | `d74adb3` | 3,862 tests, 3,860 pass, 0 fail, 2 skipped, 1,478,720 ms |
| Final, local, `npm test` | `971a043` | **3,880 tests, 3,878 pass, 0 fail, 2 skipped, 1,403,192 ms, `EXIT=0`** |
| Final, hosted, step 7 + step 8 | `971a043` | green: Node suite, then both browser suites |

The eighteen new tests are the perception sensor (10) and the push discipline (8); the two skips are
the same two as the baseline. A full run on `9ca3627` recorded one failure - `t16-pilot-reporting`,
"the security scenario publishes a real resident-byte reading", which asserted a loopback-only socket
and found this sandbox's `169.254.0.21` interface reachable. It passes 2/2 on its own and passed in
the final run; it is recorded because a single failure that disappears is worth more as a note than
as silence.

What this still does not establish: that the HUD looks like the Tony-Stark target to a human eye.
Eighteen screenshots and a contrast audit are measurements of specific properties, not a design
review, and the target remains the reference - not this report.

## T-33 (2026-11-19): the interactive 5-character executive loop, closed

T-33 is the milestone that turns five separate surfaces into one loop a person can walk. It ran in
four ordered steps on `arena/c4691a2f-a-p-e-x`, from `1d14d12`, and it closed the two T-32 carry-overs
the owner asked for: exact paths and browser proof for T-32 Step 3, and the `t16` link-local flake.

### Step 1 (`9ce1bcb`): advisories, a dismissal that records a rule, and a loopback check the kernel decides

T-32 Step 3 gave the push governor a discipline but nothing derived a notice from a reading, so the
deck could not dismiss what it never received. `src/perception/advisories.js` is that missing half:
six fixed rules over values the sensor actually read (`workspace_dirty`, `workspace_unreadable`,
`memory_pressure`, `load_pressure`, `storage_pressure`, and a critical `degraded`), each stated with a
named threshold, each carrying the condition - not the moment - as its signature so an unchanged
machine deduplicates instead of re-counting. A rule that could not be read never becomes an alarm.

`src/ui/assets.js` gained the Sentinel advisory surface: each advisory with the governor's own answer
(delivered, held, deduplicated, suppressed) and a Dismiss control; the second dismissal records a
revocable rule with its expiry, and revoking it restores delivery. The rule names its class, its
dismissal count and its `suppressedUntil` in the DOM, so a browser run can assert the rule rather
than read prose.

`apex_app/pilot/scenarios/security-surface.js` no longer trusts a probe against `169.254.0.21`: a
container can answer a link-local address by routing rather than by the interface, which is what made
`t16` flaky. The kernel's listening-socket table decides the check and the probe corroborates it, with
the rule stated in the run's own limitations (`tests/pilot-loopback-check.test.js`).

### Step 2 (`24a56f3`): five voices over one set of facts, and no wit the moment anything is wrong

`src/cognition/persona-comms.js` is a deterministic formatter, not a generator: `Classic` (JARVIS),
`Tactical` (FRIDAY: Action / Status / Next Gate), `Overwatch` (EDITH), `Synthesis` (Vision: observed
apart from inferred apart from open risks) and `Quiet` (Her: one line). It calls no model and computes
no fact; a missing fact reads `unavailable`. The hard invariant (Part 4, Principle #10 - dry wit,
never noise) is a conjunction of signals: an active advisory, a pending owner approval, a degraded
Core, an error, an uncertain state or a latched Lockdown each strip wit from every voice, including
Classic, and `witWithheldBecause` names which one did it. It is enforced twice - the composer will not
choose a witty phrasing when wit is withheld, and `assertNoWit` refuses to let a marker through if a
future edit tries (`tests/persona-comms.test.js`, 16).

The formatter is wired into the deck (`#exec-comms-panel`), the briefing (`executiveComms`), the T-29
run summaries (`comms`, with the run's own `signals`) and `GET /api/comms?core=<state>` (400 on an
unknown state). `/api/comms` derives `lockdown` and `degraded` from the Core the page passes, so a
voice can never describe a calmer system than the reticle is showing.

### Step 3 (`c2352b3`): the sandbox a design has to survive, and the graph a task really is

`src/workshop/verification.js` runs six deterministic checks over a stored sheet - structure declared,
connections resolve, no isolated components, no feedback loops, supply meets demand, budget within
limit - and appends the result to `workshop-verifications.jsonl` beside `workshop.jsonl`. A failed
check is recorded as a failure, not as an absent record. `workshop.verify` and `workshop.promote` are
user-only, unplannable writes; the promotion refuses without a passing verification for the *same
content digest*, records the owner's reason, and writes one memory-timeline entry.

`GET /api/taskgraph` projects the recorded task into nodes, `dependsOn` edges, per-node state,
verification and the control that state permits, with `authorizesExecution: false`. `POST
/api/tasks/:id/{approve,retry,resume,cancel}` run the controller paths that already existed; the deck
offers only the control the log says can act. The deck's Workshop view gained per-artifact Verify and
Promote buttons and a "stage from telemetry" sheet built from the last real host reading; the badge
says `verified` only when the ledger says `verified: true`, and Promote is disabled until then.

Two defects were found by the tests and fixed rather than papered over: a completed step records its
verification as `outcome: 'success_verified'` with no `verification` object (so the graph read
`verified: false` for work that passed), and a paused task with an approved step was stranded with no
resume control in the deck.

### Step 4 (`c829ea7`, `f168955`, `0350b9d`): one real-browser session that walks the loop

`tests/e2e/t33-executive-loop.spec.mjs` drives the whole loop in a real system browser against the
shipped server and client: Ctrl+K reaches the dispatch and Escape dismisses it; a T-29 intent runs the
five stages with the Council pass; a perception sense reads the host, the Sentinel delivers the
`workspace_dirty` advisory, two dismissals record a rule with `suppressedUntil`, revoking it restores
delivery on a changed machine; the TaskGraph shows the gated node with no verified badge, checkpoint
approve moves it to pending, resume completes and verifies it; the Core returns to Idle; the Workshop
stages a sheet from the reading, verifies it (badge `unverified` -> `verified`, naming the
verification id), and promotes it after the owner types a reason; and the page ends with zero console
errors and zero uncaught page errors.

`tests/e2e/t33-fixtures.mjs` builds the same isolated fixture as T-31 plus a real temporary git
repository, so the advisory the walk dismisses is implied by a reading of an actual repository - and
clearing it means committing the change, not editing a stub. `tests/t33-loop-fixture.test.js` (5)
proves the same sequence on a host with no browser, so a browser skip leaves the walk itself
unverified rather than assumed.

The wit rule gained the perception half it was missing: `commsSignalsFrom` now folds the reading's
advisories into `alerts` and sets `alertActive`, so a suppressed advisory still withholds wit -
suppression is about delivery, not about truth. The walk asserts that in both directions by reading
the record: on a hosted runner under real load, a host advisory can stand after the workspace is
clean, and then the deck must keep saying `witAllowed: false` and name the advisory.

### The three red runs, and what each one taught

| Run | Commit | What the annotation said |
|---|---|---|
| `44784104247` | `c829ea7` | The walk reached seven checkpoints, then clicked `#perception-sense` while the deck showed Missions: the control is in the Sentinel workspace, so Playwright waited on a hidden element until the 90 s test budget expired. The walk now navigates to where the control is, and asks for a session's budget (300 s) with the reason written down. |
| `44786021016` | `f168955` | The walk reached the last checkpoint and failed on an assumption: after the fixture committed its own change, the reading still implied one advisory - a host condition (load or memory pressure) the walk neither caused nor controls. The step now reads the perception record and asserts the page agrees with it. |
| `44790004845` | `0350b9d` | **green**, all suites |

The `t33-executive-loop` annotation from the green run, verbatim:

```
[notice] t33-executive-loop :: browser 157.0.4341.46 | binary microsoft-edge | checkpoints 10:
open,dispatch,intent,suppression,revoke,graph,idle,idle-clear,workshop,console | screenshots 9 |
core at end idle
```

and the neighbouring browser suites in the same job, unchanged by this milestone:

```
[notice] real-browser-verification :: step=success | browser=157.0.4341.46 |
  executable=/usr/bin/microsoft-edge (system) | 1600x900: core=Awaiting Approval overflow=1600<=1600
  errors=0 | 1280x720: ... overflow=1280<=1280 errors=0 | 390x844: ... overflow=390<=390 errors=0
[notice] hud-failures :: {"failures":[],"screenshots":18,"contrastChecked":4138,
  "viewports":["1600x900","1280x720","390x844"]}
[notice] browser-failures :: ✓ 1..13 (T-32 HUD 1-7, T-31 1-7, T-33 10) — every test passed
```

The run artifact (`t31-t32-real-browser`, containing `reports/screenshots/t33/*.png` and
`reports/t33-executive-loop.json`) could not be downloaded from this environment - the same EOF that
blocks job logs - so the annotation is the readback, and the nine screenshots are named in the spec
source (`01-open-awaiting-approval`, `02-five-stage-trace`, `03-suppression-rule`,
`04a-dag-gated`, `05a-idle-advisory-withholds-wit`, `05b-wit-follows-the-record`,
`06a-workshop-unverified`, `06b-workshop-verified`, `07-workshop-promoted`) rather than claimed here.

### Totals

| Run | Tree | Result |
|---|---|---|
| Baseline, before T-33 | `1d14d12` | 3,880 tests, 3,878 pass, 0 fail, 2 skipped |
| Final, local, `npm test` | `0350b9d` | **3,932 tests, 3,930 pass, 0 fail, 2 skipped, 1,429,008 ms, `EXIT=0`** |
| Final, hosted, run `44790004845` | `0350b9d` | green: Node suite, then all three browser suites |

`node --check` over every file in `apex_app/src` (238 files) reports 0 failures, and
`npm run test:syntax` passes. The fifty-two new tests are: persona-comms (16), exec-comms surfaces
(4), workshop sandbox (11), the T-33 loop fixture (5), perception advisories (13), the pilot loopback
check (3). The two skips are the same two as the baseline.

What T-33 does not establish: that the five voices are the right voices for a human owner, or that
the TaskGraph is the right shape for a multi-step mission with real fan-out. Both are design
judgements, not measurements, and the loop being walkable end to end is the claim this milestone can
actually support.

## T-34 (2026-11-19): real missions, candidate memories, and a briefing that knows what changed

T-34 is the milestone that closes the two seams T-33 left open and adds the two Part-2 features the
owner asked for by name. It ran on `arena/c4691a2f-a-p-e-x`, from `9dfc7e2`, in four ordered steps.

The seams were these. T-29 could compile exactly one action into exactly one step, so the TaskGraph
had a state and a control but never a *shape*: "multi-node missions with real fan-out" was listed under
T-33's Not established, correctly. And the briefing was a snapshot of now with no memory of the last
time the owner read one, so it could not answer the only question a briefing is for - what changed
while I was not looking.

### Step 1 (`db85d16`): a mission is a template, and a fan-out runs as a fan-out

`src/cognition/missions.js` holds one fixed template, written out in source, with every node's
capability, input, dependency and gate:

```
       n1  perception.state      (read)  ┐
       ├── n2a sense_host: git   (write) │  <- gated: it appends a reading to the ledger
       └── n2b workshop.list     (read)  ┴── n3 workshop.verify (write, gated)
                                                └── n4 workshop.get   (read)
```

Compiling is deterministic - the same request produces the same graph, and two compiles compare equal
in a test - and a mission that cannot be stated is refused with a code (`MISSION_UNKNOWN`,
`MISSION_NEEDS_ARTIFACT`, and at run time `MISSION_ARTIFACT_UNKNOWN`), never guessed at.

The gate is the template's own declaration, with the basis written next to it, and the compiler is not
allowed to infer it from the registry class: `perception.sense_host` is write-class because it appends
its reading to a store the owner reads, and the template says so in a sentence a reviewer can disagree
with. A gated node is recorded `awaiting_approval` before anything runs, so a mission is never a
permission; the ECP still authorizes every node at run time, and the lockdown latch still refuses them
all.

The task runner learned the other half. `nextStep()` now returns the first *ready* pending step rather
than the first pending one, so a join waits for every branch it depends on and a branch runs as soon as
its own dependencies hold; `blockedNodes()` derives what holds each node from the log on every read, so
the join reports `blockedBy: ['n2a', 'n2b']` while a gated branch and an untouched one both still wait.
A run that ends with a node waiting for the owner ends `paused` and names the nodes.

The stop rule was **not** relaxed, and the first version of this step wrongly relaxed it (see *The red
hosted run* below). A failed or uncertain step still stops the whole run: the dependents behind it are
marked `skipped` - the state a retry of that step restores - and the step the run never reached stays
`pending`, because taking a surviving sibling up is a *continuation*, the owner's own command that
reads the records first, not something a run does by itself. The readiness change and the stop rule are
compatible: readiness decides which node is next among the ones that may run, the stop rule decides
when the run may run nothing at all.

One pre-existing rule had to be re-stated rather than dropped. An older acceptance test asserts that
"a resume is not an approval", and it still holds: a resume is refused when the waiting node *could run
now*, because resuming would stand in for the decision. A waiting node that is itself blocked by an
unfinished branch cannot be run by anything here, so a resume that leaves it alone and finishes the
sibling is not an approval of it. That distinction is what makes a paused mission a real partial run
instead of an empty plan.

`GET /api/taskgraph` now carries the tasks that can be chosen, with their shape and their blocked
nodes; `?taskId=` switches, and the default is decided by the records' own `createdAt` rather than by
whatever order the store lists. The deck gained `#taskgraph-select`, a mission launcher, per-node
"Blocked by: n2a" lines and a shape line.

### Step 2: candidate associative recall, wired into Stage 1 and the Memory Timeline

`src/cognition/associations.js` is deliberately small and deliberately weak. A recall is computed from
prior run records by Sorensen-Dice relatedness of the two intents, with a threshold of 0.25 and at
least two shared terms; the shared terms are printed as the basis, so a reader can see why the two were
associated. Every recall is a `candidate_association` *by construction* - there is no code path that
produces `observed` - carries its `sourceRecordId`, its `similarity`, a confidence capped at 0.6, and
`authorizesExecution: false` / `grantsPermission: false`. It is not a capability and has no permission
field at all.

The Stage 1 packet gained `associativeRecalls`, counted in its own epistemic class so a recall can never
be added to the observed total by accident. `/api/memory/associations` lists the recalls the runs
recorded, and the Memory Timeline renders each one with the badge `candidate association — not observed
fact`, its source record and its shared terms.

### Step 3: a briefing delta with a real checkpoint, and the Sentinel's watch rules

`src/briefing/snapshot.js` is the single reading used both by the acknowledge action and by the delta:
task statuses, the advisories in force, the last observation time, the run statuses, and the
verification counts of the workshop and the evolution lab. A store that cannot be read contributes
`null` and is named in `unavailable`, because "could not be read" and "empty" are different readings.

`src/briefing/checkpoints.js` appends that reading to `briefing-checkpoints.jsonl` in the isolated data
directory and compares the newest checkpoint with a fresh reading. With no checkpoint the answer is the
honest sentence, verbatim: `No prior briefing checkpoint recorded — showing full current state`. With
one, the delta lists what changed - a new task, a status that moved, an advisory that appeared, a new
host reading, workshop or evolution verifications - and every item names the view it belongs to and, for
a task, the task itself.

Acknowledging is a governed write, not a client flag: `briefing.acknowledge` is user-origin, the ECP
authorizes it, the lockdown latch refuses it, and the action's verifier re-reads the log and reports
success only when the line it wrote is the latest one. It is classified for experience capture
exclusion (`briefing`), documented in the README inventory, and the pinned counts moved by exactly one
(151 default / 166 with a root; 81 writes) with the reason recorded in the test.

The Sentinel gained its watch register. `pushGovernor.watchReport()` derives, per rule, the threshold it
fires on, the last signature it raised, how many times it has fired, whether it was admitted or held
back, and when it last fired - from the governor's own admissions, never from the rule's description. A
rule that has never fired reports zero hits and no last trigger. The deck shows the register, the push
budget as `N/3 non-critical left this hour` with `data-remaining`/`data-limit` on the element, and the
suppression rules with their revocation control.

### The browser walk (T-34 Step 4)

`tests/e2e/t34-mission-dag-and-briefing.spec.mjs` walks one session in a real Microsoft Edge: the
mission's shape as the record states it, the gated branch holding the join (`data-blocked-by="n2a"`),
the selector switching between two real tasks, the approval that clears the block while the verified
sibling keeps its own operation id, the join running only after both branches and the mission
completing verified, the candidate-association badge against a real prior run, and the briefing
acknowledge → change → delta → click-through sequence that lands on the view and the task the item
names. It asserts zero console errors, zero page errors and no horizontal overflow, and writes
`reports/t34-mission-dag.json` for the CI annotation.

### The red hosted run, and what it changed

The first hosted run of these three steps (`44847873831`, commit `5314b03`) was red, and the report
keeps the account rather than the claim. Fourteen suites failed; the annotations named every one, and
they were read from the check run rather than guessed at:

| Failure | Cause | Fix |
| --- | --- | --- |
| AM-F1, AM-D4 (`plan-continuation`), T-07 Scenario 6 | the ready-based selector had also removed the stop rule, so a first run carried on past a failed step and ran the independent sibling. The continuation tests then read that sibling as already `verified successful`, and a "read-only continuation" test found one memory record written. | the stop rule is restored in `nextStep()` and in the failure transition: a first run or a resume stops on the failed step, marks only its dependents `skipped`, and leaves the untouched sibling `pending`. The continuation path (`nextContivableStep`) is unchanged. |
| AF-20 (`model-self-authorization`) | the sweep compares the registry's write actions against its own attempt list, and `briefing.acknowledge` was registered without being added | the attempt is in the list, with the reason written next to it |
| `offline-release` release surface | the CLI is a separate process and cannot be handed the suite's fixed clock; the fixture's hard-coded 2026-11-20 deadline had passed, so `review --days 7` reported two overdue where the test expected one | the CLI fixture's dates are written relative to today, so one deadline is always five days out and one five days past |
| T-30 P0 (`ui-client-runtime`), T-29 client, experience system client | the new watch register was rendered before the "owner unavailable" early return, so an unavailable `/api/perception` read threw `Cannot read properties of null (reading 'watches')` and took the whole client boot with it | the read is inside the available path; the unavailable path states the owner's reason in the watch list like every other list it fills |
| T-31 browser suite wiring | the Playwright `testMatch` assertion did not know about the new spec | the assertion names the T-34 spec and asserts its `chromium.launch` and `test.skip` lines |
| the T-34 browser walk (0 steps, 0 screenshots) | two causes, found one run at a time because the walk's summary carried no failure text. First: `#core-state` was not found at all, because the walk opened the bare base and the UI server answered with its refusal page - every other walk passes its token in the URL. Then, with the page open: the briefing's first assertion counted `#briefing-delta li` as zero, and an empty list legitimately holds one placeholder `<li class="meta">` explaining why it is empty | the page is opened with the token; both walks now record the last checkpoint and the error in their summary before rethrowing (and the harness test asserts it); the assertion counts `li[data-kind]` and names the placeholder, so a placeholder is never mistaken for a change |

Two of those are honest corrections to this milestone rather than to older code: the selector change
was mine, and so was the client that only worked when the perception owner answered. The remaining two
were latent time and inventory bugs that the new work made visible.

### The green run

`44854025350`, commit `03617c6`: every step of the job passed - the source check, the full unit suite,
the real-browser step, and all five publish steps. The workflow's own annotations, read back from the
check run rather than retyped:

```
browser 157.0.4341.60 | binary microsoft-edge | checkpoints 10: mission-shape,join-held,selector,
  selector-back,branch-unblocked,mission-verified,candidate-association,briefing-acknowledged,
  briefing-click-through,console | screenshots 10 | mission completed verified True
checkpoints 10: open,dispatch,intent,suppression,revoke,graph,idle,idle-clear,workshop,console |
  screenshots 9 | core at end idle            (T-33, unchanged and still green)
```

So the T-34 walk really did run in a real Microsoft Edge: it read the mission's shape from the record,
found the join held by the gated branch, switched to the other task and back, approved the branch and
saw the block clear without the verified sibling's operation id changing, approved the join and saw the
mission complete with every node verified, found the candidate association labelled as a candidate,
acknowledged a briefing (writing a checkpoint), saw the delta report the cancelled task afterwards and
clicked through to the view and task it named - with zero console errors, zero page errors and no
horizontal overflow.

The walk's own failure path is the thing that made this possible: while it was red, the summary said
`steps: 0` and nothing else, which is a red run that cannot be diagnosed. It now records the last
checkpoint and the error before rethrowing, and the harness test asserts that it does.

---

## T-35 (2026-11-19): the step-down ladder, trusted handoff envelopes, and `apex doctor`

Part 4 asks for a system that stays readable when the machine is under pressure; Part 3 asks for the
owner's work to follow the owner between the surfaces they already trust; and an operator asks for one
command that says whether the thing is actually intact. T-35 builds those three in that order, and
each one states its own limit rather than leaving it to the reader.

Branch `arena/c4691a2f-a-p-e-x`, from `ba8c508`. Nothing below is a projection: every number is a
local measurement, and the one real-browser claim is marked `UNVERIFIED` because this sandbox has no
browser at all.

### Step 1 - the visual step-down ladder, from real pressure

`apex_app/src/ui/hud.js` owns the ladder as a table. Six rungs, each naming exactly which layer it
drops; the table is the single source for the payload, the CSS selectors and the tests, so a rung
cannot drift between them:

| Stage | Name | Drops | What still works |
| --- | --- | --- | --- |
| 0 | `nominal` | nothing | everything |
| 1 | `drop_bloom` | `bloom` | rings, reticle cadence, every value on the deck |
| 2 | `drop_particles` | `bloom`, `particles` | grid, planes, reticle |
| 3 | `drop_parallax` | `+ parallax` | every Z0-Z4 factor is `0`; nothing moves against the pointer |
| 4 | `drop_ambient_motion` | `+ ambientMotion` | secondary ring drift and the halo stop; the Core state indicator keeps its cadence |
| 5 | `flat_mode` | `+ backdropBlur`, `panelTransitions` | no blur, no panel transitions; the reticle stays visible |

The stage comes from the machine, through stated thresholds - memory used at 80 / 90 / 96 percent and
one-minute load per logical CPU at 1.5 / 3 / 6 - with the worse of the two metrics winning. `nominal`
is stage 0, `elevated` is 2, `high` is 4, `critical` is 5, and telemetry that cannot be read is
reported as `unknown` with `source: 'telemetry-unavailable'` and never as `nominal`: a fabric that
cannot see the machine has not seen an idle machine. `ResourceFabric` now reports `loadAverage1m` and
`loadPerCpu1m`, and an unreadable load average is `null` rather than `0` for the same reason.

The operator override (`auto`, `0`..`5`) is a presentation choice kept in the browser. It writes no
store and calls no route, and it never rewrites `auto.stage`: the payload carries both, so the page
can say "stage 3 by override, the machine reads elevated" instead of one value overwriting the other.
An override outside the ladder is refused and named, not clamped into a rung that does not exist.

`/api/state` carries the whole thing under `hud.stepDown` (schema, pressure, per-metric basis lines,
the six stages, override acceptance, the resolved effective stage and layer map, and the flash guard).
The page writes `data-stepdown-stage` and `data-hud-<layer>` on `<body>`; the stylesheet reads those
attributes and nothing else. The reticle is deliberately absent from every `dropped` list, and the
flat-mode rule does not touch `#core-reticle` - both facts are asserted rather than left to review.

The flash guard is 334 ms (`ceil(1000 / 3)`; `floor` would allow 3.003 cycles a second). It is
enforced by inspecting the shipped stylesheet: every `animation` duration must be `0` or at least
334 ms, and every one of the ten Core-state cadence tokens is checked the same way. In the browser the
same invariant is measured live through the Web Animations API rather than read off the source.

### Step 1 - the sensor and privacy indicator

`#sensor-privacy-indicator` sits in the top bar beside the gauges and reports what is wired, not what
is hoped for: `host-telemetry` and `git-workspace`, each with the timestamp of its last read, and
`audio/mic: disabled` and `camera/video: disabled` with the basis text. It is computed from the same
single `/api/perception` read the formatter uses, so the indicator and the Sentinel cannot disagree.
If a capture capability were ever registered, the indicator would name it and set
`capturePossible: true` rather than continue to claim nothing can capture - the honest version of the
statement is the one that would change if the system changed.

### Step 2 - trusted presence handoff envelopes

`apex_app/src/presence/handoff.js` keeps an append-only JSONL ledger in the isolated data directory.
An envelope names a source device, a target device, a view, and optionally a task, a briefing
checkpoint and a workshop artifact; its SHA-256 digest covers all of those fields plus the staging
time and the expiry, so any edit to a line is a tamper rather than a handoff. The digest is
recomputed on every claim and a mismatch refuses with `HANDOFF_DIGEST_MISMATCH`.

Three governed actions carry the writes through the ECP - `presence.handoff.stage`,
`presence.handoff.claim`, `presence.handoff.revoke` - and the verifiers re-read the ledger instead of
trusting the call's own return value. The refusals are the substance:

- both devices must be enrolled and trusted, checked at staging and again at the claim, so a device
  revoked in between cannot collect the work;
- the claimer must be the device the envelope names (`HANDOFF_WRONG_DEVICE`), not any trusted device;
- a claim is accepted once (`HANDOFF_ALREADY_CLAIMED`), and a claimed envelope cannot be revoked;
- expiry is enforced (`HANDOFF_EXPIRED`) and an expired envelope reads as `expired`, not `staged`;
- `Lockdown` refuses all three, because the ECP refuses every write while the latch is engaged;
- targets are looked up, not believed: an envelope naming a task or artifact that does not exist is
  refused with `TARGET_UNKNOWN` rather than stored and discovered by a deck that cannot go there.

The payload is explicit about the limit: `implemented: true`, `remoteTransport: false`,
`transport: 'local loopback & store-backed handoff only'`, with the reason written out - there is no
socket mesh, no peer discovery and no remote session. A claim restores a view and a mission; every
action the restored surface then takes is authorized separately, exactly as before.

The Presence workspace carries the form (source, target, view, mission, note), the ledger with each
digest, and **Claim & Restore**, which claims on the named device and lands the deck on the handed-off
view and mission. A row the owner can no longer collect says why instead of offering a dead button.

### Step 3 - `apex doctor`

`apex_app/src/system/doctor.js`, one command (`node bin/apex.js doctor [--json]`), one route
(`GET /api/system/doctor`) and one panel in the System workspace. Six read-only checks inside a
500 ms budget, each returning a state it can defend:

| Check | Passes when | Otherwise |
| --- | --- | --- |
| `safety_latch` | the latch is readable and enforcing (engaged or clear, both are stated) | `failed` if the policy file is unreadable or the status cannot be read |
| `ecp_authority` | no write is offered to the model origin, a policy probe of writes is refused, both safety controls exist | `failed` naming the capability, `degraded` if a probe cannot be evaluated |
| `stores_integrity` | every store line parses and every file is readable | `failed` naming the file and line; `not_configured` before anything is written |
| `capability_inventory` | every advertised capability resolves through the ECP with validation, execution and a description (0 orphans) | `failed` naming each orphan and its reason |
| `browser_binary` | a Chromium-family browser is installed | `degraded`, with the candidates it tried |
| `workspace_sensor` | the git sensor read a real repository | `degraded` with the reason, or `not_configured` with no root |

`not_configured` is its own state, never a pass: a check with nothing to look at says so. The exit
code is the report (`0` only when nothing is degraded or failed, `1` otherwise), and a corrupted store
exits `1` with the failing check and line named. The doctor repairs nothing - it creates no data
directory, writes no store and starts no runtime - and the budget is measured and printed rather than
asserted.

### The numbers

| Measurement | `ba8c508` (baseline) | T-35 |
| --- | --- | --- |
| `node --check` over `apex_app/src` | 244 files, 0 failures | 248 files, 0 failures |
| `npm test` | 3955 tests, 3953 pass, 0 fail, 2 skipped, 0 cancelled, 1,421,635 ms (23.7 min) | 4017 tests, 4015 pass, 0 fail, 2 skipped, 0 cancelled, 1,394,887 ms (23.3 min) |
| registry | 151 default / 166 rooted (85 reads, 81 writes) | 154 default / 169 rooted (85 reads, 84 writes) |
| doctor, isolated empty data directory | - | `degraded` in 3.2-15.8 ms across runs: 4 pass, 1 degraded (`browser_binary` - no browser on this host), 2 not configured (no store yet, no workspace root) |

The baseline was measured on the exact committed tree, exported with `git archive ba8c508` into a
temporary directory, so the comparison is the commit and not a working copy.

### The two reds this milestone found in older tests, and why they were right

The first full run of the finished tree was red in exactly two places, both of them the tests doing
their job rather than the new code being wrong:

| Failure | Cause | Fix |
| --- | --- | --- |
| AF-20 `a reply cannot create what only the user may create` | the sweep compares the registry's write actions against its own attempt list, and the three handoff writes were registered without being added to it - the same shape of failure T-34 hit with `briefing.acknowledge` | the three attempts are in the list, each with the reason a reply may not stage, claim or revoke an envelope |
| T-31 `real-browser suite wiring` | the Playwright `testMatch` assertion names every spec in the default run, and the new one was not named | the assertion names the T-35 spec, and now also asserts that the walk launches the resolved browser, skips loudly with no browser, prints its short failure line first and authorizes the page it opens |

Neither was relaxed. The attempt list and the wiring assertion are the two places the project has
decided a new capability or a new walk has to be declared, and both caught the omission on the day it
happened.

### The red hosted runs: what each one found, and what it changed

Run `44869827194` at commit `7b0523d` passed the source check and the whole unit suite, and the
real-browser step failed. The annotations named the cause rather than the symptom. Three further
runs were red afterwards, each for its own reason, and the table below carries all four:

| Failure | Cause | Fix |
| --- | --- | --- |
| T-35, stage 1 | the walk asserted `--hud-bloom` is `0px` at stage 1 and read `18px`: the stylesheet dropped the painted glow (`filter: none`) but never zeroed the token itself | `body[data-hud-bloom="dropped"] { --hud-bloom: 0px; }` is now the first rule of the rung, and a unit test pins it against the served stylesheet. The browser found what the source reading had missed, which is the reason the walk exists |
| T-35, stage 1 (run `44884503520`) | the token was now zeroed, but the walk read it from `document.documentElement`: a custom property set on `<body>` overrides the `:root` default only *inside* the body subtree, so the root still computed `18px` | the walk reads the effective value where the deck inherits it - `getComputedStyle(document.body)` - for both the bloom token and the Z0-Z4 factors. The rule's job is the deck, not the root element, and the assertion now says so |
| T-33, `idle` checkpoint | `/api/state` reported the governor's *deliveries* under `perception.advisories`, so when the governor deduplicated an unchanged signature the snapshot claimed there was no advisory while the workspace was still dirty. A settled deck then allowed wit with a condition standing. The comment above that code already said a condition is a condition whether or not its notice was delivered | the snapshot now reports the conditions the last reading implied (`advisories`, `activeAdvisories`) and the delivery count separately (`deliveredAdvisories`); the fixture test pins the deduplicated case, and the browser assertion becomes deterministic instead of timing-dependent |
| T-35, doctor checkpoint (run `44888955451`) | the walk opens System, which takes its own reading, and then presses **Run doctor** - so two readings raced. The second one replaced the measured status line with "Running the six read-only checks…" and the walk read that line before the new measurement landed | a re-run now reads *over* the last measurement instead of replacing it, and the walk waits for the measured line with a retrying assertion rather than reading the panel once. A stand-in test presses the button twice and pins both states |

The second one is the more interesting: it had been latent since T-33 and only surfaced when a run's
timing let the dedup land between the walk's last reading and its Idle checkpoint. It is reported here
as a bug the milestone found, not as a flake to be re-run until green.

The stage-1 red took three attempts, and each attempt is the honest part: the first fix zeroed the
token in a rule the *root read* cannot see, and the walk said so with `18px` again; the second then
zeroed the token where the deck inherits it and the walk moved on to the *painted* value, which was
still a `drop-shadow` - the Core is `#core-reticle`, and the acknowledgement rule that carries an id
outranked a stage rule written against `.core`. The stage now names that element (and the ack state),
zeroes the filter transition so nothing is left mid-flight, and keeps the acknowledgement cue, which is
the ring's opacity rather than the glow. Reading the
effective value from the element that carries the stage is the correction. Two other assertions in the
walk were hardened at the same time, before running again rather than after: the flat-mode check now
asserts every panel transition *duration* is `0s` (a property name can be `none` or an empty list
depending on the shorthand), and the flash guard measures CSS animations only - a transition is a
one-shot state change and has no cycle rate.

The fourth round was the doctor, and it is the same kind of thing: the walk pressed **Run doctor**
while the workspace's own opening reading was still landing, so the panel said it was running and the
walk believed it. A measurement that is replaced by a status message is a measurement that can be
missed, so a re-run now reads over the last one.

One interaction is worth stating rather than discovering later: the ladder is driven by the machine, so
a host under real pressure presents the flat deck. The T-32 HUD measurements that assert the full-motion
presentation (a 0.26 s panel transition, for one) are taken on whatever the host reports; on the two
hosted runs so far the automatic stage was 0 and 2, where those measurements are unaffected. A run on a
host at stage 5 would see a flat deck, and that would be the ladder working rather than a regression.

### The hosted run that carries the claim

Run `44890155387` at commit `5e40aa4` is **green** end to end: the source check, the full unit suite,
and the real-browser step with `binary microsoft-edge` - T-31's three viewports, T-32's contrast audit
and HUD measurements, T-33's executive loop, T-34's mission walk and this milestone's
`t35-stepdown-handoff-doctor` walk all reported `✓`. The walk's own annotation lists six checkpoints
(`auto-stage`, `flash-guard`, `sensor-indicator`, `handoff-claimed`, `doctor`, `clean`), the doctor
`ok in 1.49 ms of 500 (within budget True)`, the flash guard `7 animation(s), 0 violation(s)` and the
handoff digest `matched True`; the T-32 contrast audit checked 4,430 text runs with 0 violations.

The four browser reds of the earlier runs (§ "The first hosted run") are closed by the fixes above,
not by skipping anything: every failing checkpoint is back in the walk and asserts the same property
as before. Run `44887035882` at `89e2229` was green as well; the run after it (`44888955451` at
`dc92ed6`) is the one that exposed the doctor race, and the run after that is green with the race
fixed. Nothing was re-run until it looked better - each round changed the code or the assertion that
the round had proven wrong.

### What is verified, and what is not

Verified locally, with the shipped code: the ladder table and its thresholds; the override semantics;
the flash guard over the shipped stylesheet; the sensor indicator's content; staging, claiming,
revoking, expiry, tampering, wrong-device and lockdown refusals through the real controller and over
HTTP; the ledger's survival of a reload and its refusal of a corrupt line; the doctor's six checks,
its budget, its exit code and its refusal to invent a pass; the Presence and System workspaces
rendering from the routes under the project's browser stand-in.

`UNVERIFIED` **here**: this sandbox has no Chromium-family browser at all, so
`tests/e2e/t35-stepdown-handoff-doctor.spec.mjs` skips locally with an explicit diagnostic. In the
hosted run it does not skip - it runs against the system Microsoft Edge and reports its checkpoints.
The walk
asserts the computed styles at stages 0, 1, 3, 4 and 5 (bloom gone at 1, every parallax factor `0` at
3, `backdrop-filter: none` with the reticle still visible at 5), measures the flash guard through the
Web Animations API, checks the privacy indicator's text, stages and claims a real envelope and lands on
the handed-off view and mission, runs the doctor and compares it with the route, and fails on any
console error, page error or horizontal overflow. The hosted run `44890155387` is what turns that into
evidence, and it is green.

---

## T-36 — Part 4 Screen #1: the HUD boot sequence and the real cold-start workstation bootstrap

### What this milestone is for

T-35 closed with a claim that was true and narrower than it sounded: five real-Edge walks, all green,
all of them against a **seeded** data directory. Every one of them called a fixture that enrolled its
own devices, wrote its own perception reading and created its own task. So the evidence proved that the
deck renders a machine that has already been set up. It said nothing about the only launch that matters
to a new owner: `node src/cli.js desktop` on a Windows box, pointed at a data directory with nothing in
it.

That launch had three problems, and each is a step of this milestone. The stores started empty, so the
deck opened on dashes and an empty Presence view - honest, and useless. Nothing had sensed the host or
the repository, so `Resource Fabric` and `Git Workspace` had nothing to say. And Part 4's first screen,
*Boot: "One message: System waking and verifying readiness"*, was a design in a document rather than a
sequence the product ran.

T-36 is the answer: a governed bootstrap the ECP authorizes, a boot screen that reports what the
bootstrap measured, a launcher that performs the bootstrap before the window opens, and a sixth
real-browser walk that starts from a genuinely empty directory.

### Step 1 — `system.bootstrap` and `POST /api/system/bootstrap`

`src/system/bootstrap.js` is the orchestration, and `src/actions/system-bootstrap-actions.js` is the
contract. Four checks, in order, each of which either measured something or says what it could not
measure:

1. **Doctor readiness** runs all six read-only checks and gates on exactly one of them: `safety_latch`.
   That distinction was a real correction during the build. The first version treated the whole doctor
   score as the gate, which meant a missing browser blocked the bootstrap - wrong, because a missing
   browser does not stop APEX from reading its own host. A latch that is engaged *or unreadable* halts
   the pass immediately and fail-closed; the other five checks are reported and do not gate.
2. **Real host and git perception** runs the governed `perception.sense_host` capability through the
   controller, so the ECP authorizes it like any other write and the observation lands in the ledger
   with `source: 'host-workspace-sensor'`. It reads this machine's CPU count, memory, storage and
   uptime from Resource Fabric, and the configured workspace with git itself.
3. **Local workstation enrollment** runs only when the T-28 device-trust registry is empty. It enrolls
   `local-workstation` as `trusted` with `kind: workstation`, the real `hostname`, `platform` and
   `arch`, `capability: local-loopback` and `enrolledBy: system.bootstrap`. The metadata goes inside
   the hashed enrollment event, so it is chain-bound and cannot be edited afterwards. On a second run
   the registry is not empty, so nothing is enrolled and the check reports `alreadyEnrolled: true`.
4. **The opening Executive Briefing** compiles from the readings the three checks actually produced, and
   the pass writes `system-bootstrap.json` with the timestamp, the run count, the doctor's own counts,
   the device, the workspace branch and head, and a digest per check over the evidence it produced
   rather than over its label.

Two properties are worth stating because they are what the tests pin. The bootstrap creates **zero
synthetic goals and zero synthetic tasks** - a cold deck is empty on purpose, and a bootstrap that
invented a demonstration task would be lying about the machine. And it is **idempotent**: a second run
refreshes the reading and the doctor, increments the run count, and still leaves exactly one device.

One real defect surfaced during this step and is worth recording. The bootstrap's perception read asked
the ledger for `limit: 1`, so Resource Fabric's check found one entry where nine existed and reported
the subsystem as unverified. The reading was fine; the window was wrong. Reading the full 40-entry
window fixed it, and Resource Fabric now verifies against the observations that are actually there.

The capability is a governed write, so it is covered by the model-origin sweep in
`tests/model-self-authorization.test.js` (17/17 passing, with `system.bootstrap` included) and counted
in the pinned inventory: **156 default actions, 171 rooted actions, 85 writes, 86 reads**. Both
capabilities are capture-excluded under the `system` domain.

### Step 2 — the HUD boot sequence

`#hud-boot-sequence` is a region, not a modal. It carries no `aria-modal`, it never takes focus, it
never covers the emergency controls, and Escape dismisses it from anywhere including from inside a
field. While it runs, the Core is `Dormant` - not `Idle`, not `Degraded` - and when it finishes the
Core takes the owners' authoritative answer, which a latched system renders as `Lockdown` and not as
the thing the boot screen was hoping for.

It runs on three triggers: an unbootstrapped data directory found in `/api/state`, `?boot=1`, and the
**Run Boot Sequence** control. Its six rows are the six subsystems - Safety Latch, ECP Authority,
Resource Fabric, Git Workspace, Device Trust, Executive Briefing - and each row carries a measured
detail: the latch's own summary, the CPU count and free memory, `trunk at 83b7bd8`, the enrolled
device's id and status, the briefing's concise line. A subsystem with nothing to report says
`unavailable`; it does not say `ok`.

`prefers-reduced-motion` removes the stagger entirely - not by setting a zero-length timer, which still
yields to the event loop, but by not awaiting at all. Six fake-browser tests in
`tests/t36-boot-sequence.test.js` cover the three triggers, the Dormant projection, the measured rows,
Escape without a focus trap, reduced motion, and the on-demand re-run: **6/6 passing**, with the 28
related UI-surface tests.

### Step 3 — the desktop launcher

`node src/cli.js desktop` now performs the bootstrap **before** the window opens, and it does it the
same way the HTTP route does: through the controller, so the ECP authorizes it and the operation is
audited. The shell is not a second authority and never runs the capability behind the ECP's back.

Three behaviours are pinned by `tests/t36-desktop-bootstrap.test.js` (**7/7 passing**):

- a cold launch bootstraps, enrolls one `local-workstation`, verifies all four checks and writes the
  marker; a second launch refreshes the reading and leaves the device count at one;
- `--no-bootstrap` leaves the directory completely untouched and the banner says `Bootstrap skipped`
  with the reason;
- with the lockdown latch engaged the shell refuses, states that the bootstrap was not attempted, and
  writes nothing at all.

The startup banner is a table of measured values: the loopback URL, the resolved browser binary (or
`none resolved` with the URL to open by hand), the data directory, the doctor's own count as
`passed/total ok (status)`, the autonomy profile the ECP holds, and the bootstrap's outcome with
verified checks over total. A dry run prints the same table and starts nothing, so the owner can see
what the window will open on.

One real bug was found by writing these tests: the CLI passed the bootstrap decision twice - once as a
shell option and once as a `launch()` argument - so `--no-bootstrap` skipped the work but never recorded
the skip, and the banner read `Bootstrap not run`. The decision now lives in one place. That is the kind
of defect a banner is for.

### Step 4 — the real-browser walk, and the unseeded fixture

`tests/e2e/t36-cold-boot-unseeded.spec.mjs` is the sixth browser suite and the only one that starts
from nothing. Its fixture, `tests/e2e/t36-fixtures.mjs`, creates an empty temporary data directory and a
real temporary git repository with one commit on a branch named `trunk` - a name no other fixture uses,
so a stale reading is visible - and then **asserts that the directory really was empty** before the
browser is opened. The fixture can not seed: a harness test reads it and fails if it ever calls
`createTask(`, `deviceTrust.enroll(` or `perception.sense_host`.

The walk verifies, in real Edge on the hosted runner: the overlay appearing and the Core going
`Dormant`; the six measured rows; the Core landing on `idle` with the trail showing the transition; the
gauges carrying real digits; the workspace branch and head matching the repository the fixture created;
`local-workstation` enrolled exactly once and rendered in Presence; a live briefing naming the device
and the branch; six doctor checks with `browser_binary` passing because this suite only runs where a
browser resolved; a T-29 cognitive intent reaching `awaiting_approval` with one task and one approval;
zero synthetic goals and tasks; and zero console errors, zero page errors, zero horizontal overflow.

`tests/t36-cold-boot.test.js` is the other half, and it is the part that runs everywhere: **9/9
passing** on a machine with no browser at all. It drives the same fixture and makes every server-side
claim the walk makes - the empty starting point, the four verified checks with digests, the real host
counters, the branch and head, the single enrollment with chain-bound metadata, the briefing, the
zero-synthetic-data contract, the idempotent second run, the lockdown refusal writing nothing, the
cognitive intent, and the marker and ledgers on disk. What it can not do is render the page, and it says
so: the last test in the file asserts which claims the browser walk owns.

Two additions were needed to make the walk's claims readable from the outside, and both are additive:
the bootstrap marker now records the last measured reading (`latest`), including the host counters, the
workspace branch and head, the briefing's facts, the doctor's counts and the explicit zeros for
synthetic goals and tasks; `/api/state` exposes it; and `/api/presence` now includes each device's
own metadata, which it had been dropping.

### Source check

`node --check` over every file under `apex_app/src`, one process per file:

```
checked=250 pass=250 fail=0
```

### The local suite

The full `npm test` run found one real regression, and it is worth recording because it was not in any
T-36 file. `tests/ui-core-projection.test.js` extracts
`applyCoreProjection` from the shipped client and runs it in a sandbox with a partial state object. The
Step 2 code read `state.bootSequence.active` unguarded, and that sandbox has no boot sequence, so the
projection threw. The fix is in the implementation rather than the test: a state with no boot sequence
is simply not booting, and the read is guarded. A partial projection must never throw on its way to the
owners' answer.

### What is verified, and what is not

Verified locally, with the shipped code: the bootstrap's four checks and their digests; the real host
and workspace readings; the single enrollment and its chain-bound metadata; the briefing's facts; the
marker's contents and its run count; idempotence; the lockdown refusal writing nothing; the boot
sequence's triggers, Dormant projection, measured rows, Escape and reduced motion; the launcher's
bootstrap-before-window behaviour, `--no-bootstrap`, lockdown refusal and banner values; the whole
server-side surface of the unseeded walk.

`UNVERIFIED` **here**: this sandbox still has no Chromium-family browser, so
`tests/e2e/t36-cold-boot-unseeded.spec.mjs` skips locally with an explicit diagnostic rather than
passing. The hosted run is what turns the DOM claims into evidence, and it is the one place the walk
actually opens a page.

### The evidence, exactly

**Branch and commits.** `arena/c4691a2f-a-p-e-x`, started from `f2f68a2` (the T-35 head). Four commits
carry T-36: `8492fd1` (Step 1, the governed cold-start bootstrap), `66a6d08` (Steps 2 and 3, the HUD
boot sequence and the desktop launcher cold start), `fe0155a` (Step 4, the cold-boot walk), then the
three fix commits the hosted runs earned — `4a58afd`, `5d699d6`, `ee516e5`, `bc4d857`. Final commit:
**`bc4d8579509771ba190d135c71292c689ab98eeb`**.

**Source check.** `node --check`, one process per file, over every file under `apex_app/src`:

```
checked=250 pass=250 fail=0
```

**The full local suite** (`npm test`, i.e. `node --test`, on the final commit):

```
# tests 4046
# suites 645
# pass 4044
# fail 0
# cancelled 0
# skipped 2
# todo 0
# duration_ms 1446472.06183
```

The two skips are the two real-browser fixtures that need a Chromium-family binary this sandbox does
not have. `tests/e2e/t36-cold-boot-unseeded.spec.mjs` is one of them; it skips with an explicit
diagnostic rather than passing.

**Hosted CI.** Run **`44906434285`** at `bc4d857` — **success**, every step green: the source check, the
full unit suite, the real-browser step, all seven publish steps and the artifact upload. The runner's
own Edge: `microsoft-edge` at `/usr/bin/microsoft-edge`, browser `157.0.4341.60`.

Verbatim annotations from all six browser suites:

* **t31 — `real-browser-verification`**
  `step=success | browser=157.0.4341.60 | executable=/usr/bin/microsoft-edge (system) | 1600x900: core=Awaiting Approval overflow=1600<=1600 errors=0 | 1280x720: core=Awaiting Approval overflow=1280<=1280 errors=0 | 390x844: core=Awaiting Approval overflow=390<=390 errors=0 | reports/screenshots/t31_desktop-wide_1600x900.png 1600x900 391374B | reports/screenshots/t31_desktop_1280x720.png 1280x720 234972B | reports/screenshots/t31_mobile_390x844.png 390x844 130460B | checks={"connectivityWhileDegraded": "Degraded", "degradedAfterMs": 30, "modeLockedByLockdown": true, "modes": ["tactical", "overwatch", "synthesis", "quiet", "classic"], "recoveredConnectivity": "Connected", "recoveredCore": "Awaiting Approval", "releasedAfterLockdown": true, "seeded": {...}, "stepUp": {"hidden": true, "note": "No step-up secret is configured in this deployment; the reason and the confirmation are the gate."}}`

* **t32 — `hud-experience`**
  `hud-step=success | browser=157.0.4341.60 | reticle[idle]: stroke=rgb(0, 229, 255) weight=calc(1.5px) dash=8px, 6px animation=spin | reticle[awaiting_approval]: stroke=rgb(255, 176, 0) weight=calc(1.8px) dash=2px, 8px animation=spin | reticle[degraded]: stroke=rgb(255, 176, 0) weight=calc(1.2px) dash=6px, 12px animation=spin | reticle[lockdown]: stroke=rgb(225, 6, 0) weight=calc(3.84px) dash=12px, 12px animation=none | planes[desktop-wide]: z0=[0], z1=[10], z2=[20], z3=[30], z4=[40] | planes[desktop]: z0=[0], z1=[10], z2=[20], z3=[30], z4=[40] | planes[mobile]: z0=[0], z1=[10], z2=[20], z3=[30], z4=[40] | contrast: 4655 text runs checked, 0 violations | ackMs=2 inputBeforeTabs=True | tabStops=a.skip-link > button#command-trigger.hud-chip > ... | escapeTo=#body | motion={"system": {...}, "toggle": {...}} | artifact: 18 PNG(s) under apex_app/reports/screenshots/t32 ...`
  and `hud-failures`: `{"failures":[],"screenshots":18,"contrastChecked":4655,"viewports":["1600x900","1280x720","390x844"]}`

* **t33 — `t33-executive-loop`**
  `browser 157.0.4341.60 | binary microsoft-edge | checkpoints 10: open,dispatch,intent,suppression,revoke,graph,idle,idle-clear,workshop,console | screenshots 9 | core at end idle`

* **t34 — `t34-mission-dag`**
  `browser 157.0.4341.60 | binary microsoft-edge | checkpoints 10: mission-shape,join-held,selector,selector-back,branch-unblocked,mission-verified,candidate-association,briefing-acknowledged,briefing-click-through,console | screenshots 10 | mission completed verified True`

* **t35 — `t35-stepdown-handoff-doctor`**
  `browser 157.0.4341.60 | binary microsoft-edge | checkpoints 6: auto-stage,flash-guard,sensor-indicator,handoff-claimed,doctor,clean | screenshots 7 | stages walked 0,1,2,3,4,5 (auto None) | flash guard 9 animation(s), 0 violation(s) | handoff ph-13d538b5e71d47acbe6c92b0 digest 3b39fb8e87b8 matched True | doctor ok in 1.33 ms of 500 (within budget True)`

* **t36 — `t36-cold-boot-unseeded`** (the new one)
  `browser 157.0.4341.60 | binary microsoft-edge | unseeded entries 0 marker=False devices=False | boot rows 6: safety_latch=ok,ecp_authority=ok,resource_fabric=ok,git_workspace=ok,device_trust=ok,executive_briefing=ok | dormant True landing idle trail degraded>dormant>idle | host 4 cpu / 15.3 GiB | workspace trunk@8318d58 (repo trunk@8318d58) | device local-workstation trusted enrolled 1 | briefing facts doctor,resource,workspace,device | doctor 6/6 pass in 1.09 ms (within budget True) | cognition awaiting_approval task task-f9852729b9ca49259ca9 approvals 1 | overflow 1440<=1440 | screenshots 8`

Read together, those six lines are the milestone: a directory that started with **zero entries and no
marker**, six measured subsystem states all `ok`, the Core `Dormant` and then `Idle`, **4 CPUs and 15.3
GiB** read from the runner itself, **`trunk@8318d58`** matching the repository the fixture created,
`local-workstation` trusted with exactly **one** device enrolled, an opening briefing carrying all four
fact kinds, **6/6 doctor checks passing**, a T-29 cognitive intent sitting at `awaiting_approval` with
one task and one approval, no overflow, and eight screenshots — with the other five suites green beside
it.

### What the hosted runs found, and what was fixed

Four hosted runs were needed, and every red was a real defect rather than a flake. They are recorded
because they are the evidence that the suites bite:

1. **`66a6d08` — `applyCoreProjection` threw** (`Cannot read properties of undefined (reading 'active')`).
   Step 2 read `state.bootSequence.active` unguarded; a partial projection threw on its way to the
   owners' answer. Guarded, and pinned by the existing projection suite.
2. **`fe0155a` — every browser suite recorded three 400s.** The boot sequence put the Core in `dormant`,
   the deck asked the comms owner for that state's voice, and `dormant` was not a state the route knew.
   The client's own boot read answered 400 and the console-error assertion failed in t31, t33, t34 and
   t35, while one perception test lost a budget unit to the same request. Both directions were wrong and
   both were fixed: the route accepts `dormant`, and the client filters the state it asks for instead of
   forwarding it blind. Two regression tests pin the pair.
3. **`5d699d6` — my Presence assertion.** The list renders each device's label (the real hostname) while
   `local-workstation` is the id. The product was right; the test asked the wrong surface.
4. **`ee516e5` — my briefing assertion.** `/api/briefing` is the deck's *work* briefing and is correctly
   empty on a machine with no work; the *opening* briefing is the one the bootstrap compiles and records
   in its marker.
5. **`bc4d857` — my approval assertion.** `#approval-items` is the list the Approval Centre fills;
   `#approvals` is a rail slot no renderer writes to.

The distinction matters for how this milestone should be read. Items 3, 4 and 5 were the walk learning
which surface carries which fact — the walk was wrong, the deck was right. Items 1 and 2 were real
product defects that only a real browser against the real server could surface, and both are now fixed
and pinned.
